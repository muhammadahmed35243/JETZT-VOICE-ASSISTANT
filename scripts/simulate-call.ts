/**
 * End-to-end call simulator. Plays the Telnyx side of a call — a WebSocket
 * carrying 20ms mulaw/8kHz frames in real time — with a synthesized caller
 * voice, so every hop runs for real: Deepgram STT + turn detection, GPT-4o +
 * tools, Deepgram TTS. Prints every step of the conversation with the
 * latency the caller would actually feel (end of their speech -> first
 * agent audio), then has a reviewer model grade the call.
 *
 *   npx tsx scripts/simulate-call.ts [scenarios] [--remote [baseUrl]]
 *
 *   scenarios   comma-separated names (see SCENARIOS), default: all
 *   --remote    call the deployed /api/media-stream instead of running the
 *               handler in-process. This is the one to trust for timing —
 *               the AI services are called from Vercel's network, not this
 *               machine's.
 *
 * Simulated calls use a `sim-` call id: the server skips every real side
 * effect for them (bookings, messages, lead notes, call logs, memory,
 * Telnyx hangup — see src/calls/simulation.ts). In-process runs also
 * sandbox fetch as a second layer.
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { EventEmitter } from "events";
import { inspect } from "util";
import { createHash } from "crypto";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
delete process.env.SUPABASE_DB_URL; // in-memory checkpointer for in-process runs

const args = process.argv.slice(2);
const remoteIdx = args.indexOf("--remote");
const REMOTE =
  remoteIdx >= 0
    ? (args[remoteIdx + 1] && !args[remoteIdx + 1].startsWith("-") ? args[remoteIdx + 1] : process.env.PUBLIC_BASE_URL)!.replace(/\/$/, "")
    : null;
const scenarioArg = args.find((a, i) => !a.startsWith("--") && i !== remoteIdx + 1) ?? "all";

// ---------- sandbox (in-process runs) ----------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  const method = (init?.method ?? (typeof input === "object" && input.method) ?? "GET").toUpperCase();
  const u = new URL(url);
  const isWrite = method !== "GET" && method !== "HEAD";
  const sandboxed =
    isWrite &&
    ((u.host.endsWith("supabase.co") && !u.pathname.includes("/rpc/")) ||
      (u.host === "www.googleapis.com" && u.pathname.startsWith("/calendar/")) ||
      u.host.includes("telnyx.com"));
  if (!sandboxed) return realFetch(input, init);
  event("sandbox", `blocked ${method} ${u.pathname}`);
  return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// ---------- output ----------
let callStart = Date.now();
const ts = () => ((Date.now() - callStart) / 1000).toFixed(1).padStart(5) + "s";
function event(kind: string, text: string) {
  process.stdout.write(`${ts()}  ${kind.padEnd(8)} ${text}\n`);
}
const VERBOSE = process.env.VERBOSE === "1";
const realLog = console.log;
let onAgentSentence: (s: string) => void = () => {};
console.log = (...a: any[]) => {
  const s = a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 2, breakLength: Infinity }))).join(" ");
  if (VERBOSE) realLog(s);
  const said = s.match(/^\[turn\] caller said: (".*") \(call/);
  if (said) event("STT", `agent heard ${said[1]}`);
  const sent = s.match(/^\[turn\] sentence \d+ ready for \S+: (".*")$/);
  if (sent) onAgentSentence(JSON.parse(sent[1]));
  if (s.includes("caller finished speaking mid-turn")) event("turn", "speech arrived mid-turn — queued");
};
console.warn = (...a: any[]) => VERBOSE && realLog(...a);
console.error = (...a: any[]) =>
  event("ERROR", a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : inspect(x, { depth: 1, breakLength: Infinity }).slice(0, 200))).join(" "));

// ---------- speech services (harness side) ----------
const DG = { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` };
const AUDIO_CACHE = path.join(process.env.TEMP ?? ".", "jetzt-sim-audio");
fs.mkdirSync(AUDIO_CACHE, { recursive: true });

async function callerAudio(text: string): Promise<Buffer> {
  const file = path.join(AUDIO_CACHE, createHash("sha1").update(text).digest("hex") + ".ulaw");
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await realFetch("https://api.deepgram.com/v1/speak?model=aura-2-orion-en&encoding=mulaw&sample_rate=8000&container=none", {
        method: "POST",
        headers: { ...DG, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`caller TTS ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (err) {
      if (attempt >= 4) throw err;
    }
  }
}

/** What the caller actually hears — transcribes the agent's audio, which
 *  also catches pronunciation problems the text alone would hide. */
async function transcribe(audio: Buffer): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await realFetch("https://api.deepgram.com/v1/listen?model=nova-3&encoding=mulaw&sample_rate=8000&smart_format=true&keyterm=JETZT", {
        method: "POST",
        headers: { ...DG, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(audio),
      });
      const json: any = await res.json();
      return json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    } catch (err) {
      if (attempt >= 3) return `(transcription failed: ${(err as Error).message})`;
    }
  }
}

async function chat(model: string, messages: Array<{ role: string; content: string }>, json = false): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await realFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0.7, ...(json ? { response_format: { type: "json_object" } } : {}) }),
      });
      const body: any = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? res.status);
      return body.choices[0].message.content;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

// ---------- scenarios ----------
type Step = { say: string; thenImmediately?: boolean } | { sayDuringGreeting: string } | { silence: number } | { expectHangup: true };
interface Persona {
  persona: string;
  maxTurns: number;
}

const SCRIPTED: Record<string, Step[]> = {
  // Speaks over the greeting — used to be ignored, leaving the agent silent.
  overlap: [{ sayDuringGreeting: "Hello? Hi, is this JETZT?" }, { say: "Okay, thanks. Bye." }, { expectHangup: true }],
  // Pauses mid-sentence: the agent shouldn't answer half a question.
  "mid-pause": [
    { say: "So I was wondering,", thenImmediately: true },
    { say: "if you could tell me how pricing works for your service." },
    { say: "Okay, that's all. Bye." },
    { expectHangup: true },
  ],
  // Says nothing: expect "are you still there?", then a goodbye and hangup.
  silence: [{ silence: 30000 }, { expectHangup: true }],
  // Nonsense from line noise: should ask to repeat, not answer it.
  garbled: [{ say: "Quarterback." }, { say: "Sorry, never mind. Bye." }, { expectHangup: true }],
};

const PERSONAS: Record<string, Persona> = {
  "prospect-books-call": {
    persona:
      "You're Sarah Klein, office manager at a dental clinic in Austin, Texas (Central time). You miss lots of calls and heard JETZT builds AI receptionists. You want to learn if it fits and, if it sounds reasonable, book a call with their team for some weekday afternoon. Your email is sarah.klein@gmail.com. Answer naturally and briefly like a real caller, one or two sentences. When it's booked and you're done, say goodbye.",
    maxTurns: 14,
  },
  "message-hard-email": {
    persona:
      "You're Muhammad Ahmed, calling from Lahore. You speak South Asian English and say 'at the rate of' for @. You want someone from JETZT to email you about a custom voice assistant for your company. Your email is muhammadahmed8775@gmail.com — spell it in pieces when asked. If the agent reads it back wrong, correct only the wrong part. Keep replies short. Once they've taken the message, say goodbye.",
    maxTurns: 14,
  },
  "skeptical-shopper": {
    persona:
      "You're a busy, slightly impatient restaurant owner. You want to know straight away what JETZT does and roughly what it costs. You push back once if the answer is vague. You don't want to give your email or book anything today. Keep replies very short, sometimes just a few words. Say goodbye after 4 or 5 exchanges.",
    maxTurns: 8,
  },
  "cancel-meeting": {
    persona:
      "You booked a call with JETZT last week and want to cancel it because you went with someone else. Be polite and brief. If they say they can't find a meeting, accept that and say goodbye.",
    maxTurns: 6,
  },
};

// ---------- transports ----------
interface AgentLink {
  toAgent(obj: unknown): void;
  closed: boolean;
  onAgentAudio: (chunk: Buffer) => void;
  close(): void;
}

class InProcessSocket extends EventEmitter implements AgentLink {
  readonly OPEN = 1;
  readyState = 1;
  closed = false;
  onAgentAudio: (chunk: Buffer) => void = () => {};
  send(data: string) {
    const msg = JSON.parse(data);
    if (msg.event === "media") this.onAgentAudio(Buffer.from(msg.media.payload, "base64"));
  }
  toAgent(obj: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

async function remoteLink(): Promise<AgentLink> {
  const WS = (await import("ws")).default;
  const token = createHash("sha256").update(`media-stream:${process.env.TELNYX_API_KEY}`).digest("hex").slice(0, 32);
  const ws = new WS(`${REMOTE!.replace(/^http/, "ws")}/api/media-stream?token=${token}`);
  const link: AgentLink = {
    closed: false,
    onAgentAudio: () => {},
    toAgent: (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  };
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.event === "media") link.onAgentAudio(Buffer.from(msg.media.payload, "base64"));
  });
  ws.on("close", () => (link.closed = true));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)));
  });
  return link;
}

let inProcessHandler: ((ws: any, opts: { authenticated: boolean }) => void) | null = null;

// ---------- one call ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESPONSE_TIMEOUT_MS = Number(process.env.RESPONSE_TIMEOUT_MS ?? (REMOTE ? 15000 : 45000));

interface CallResult {
  name: string;
  failures: string[];
  latencies: number[];
  transcript: string[];
  review?: string;
}

async function runCall(name: string, script: Step[] | Persona): Promise<CallResult> {
  realLog(`\n=============== ${name} ${REMOTE ? "(remote)" : "(in-process)"} ===============`);
  const result: CallResult = { name, failures: [], latencies: [], transcript: [] };
  const fail = (why: string) => {
    event("FAIL", why);
    result.failures.push(why);
  };

  let link: AgentLink | undefined;
  if (REMOTE) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5 && !link!; attempt++) {
      try {
        link = await remoteLink();
      } catch (err) {
        lastErr = err;
        await sleep(3000); // flaky local DNS/network — not the server
      }
    }
    if (!link!) {
      fail(`couldn't connect: ${(lastErr as Error).message}`);
      return result;
    }
  } else {
    const sock = new InProcessSocket();
    inProcessHandler!(sock, { authenticated: true });
    link = sock;
  }

  // Agent audio bookkeeping: when it finishes playing, and what it said.
  let playbackEndsAt = 0;
  let lastAgentAudioAt = 0;
  let agentChunks = 0;
  let turnAudio: Buffer[] = [];
  let turnText: string[] = [];
  link.onAgentAudio = (chunk) => {
    const now = Date.now();
    playbackEndsAt = Math.max(now, playbackEndsAt) + chunk.byteLength / 8;
    lastAgentAudioAt = now;
    agentChunks++;
    turnAudio.push(chunk);
  };
  onAgentSentence = (s) => turnText.push(s);

  callStart = Date.now();
  let queue = Buffer.alloc(0);
  let callerSpeaking = false;
  let callerDoneAt = 0;
  const SILENCE = Buffer.alloc(160, 0xff);
  let seq = 0;
  const pump = setInterval(() => {
    let frame = SILENCE;
    if (queue.length > 0) {
      frame = Buffer.from(queue.subarray(0, 160));
      queue = queue.subarray(160);
      if (queue.length === 0) {
        callerSpeaking = false;
        callerDoneAt = Date.now();
      }
    }
    link.toAgent({ event: "media", sequence_number: String(++seq), media: { track: "inbound", payload: frame.toString("base64") } });
  }, 20);

  const speak = async (text: string) => {
    const audio = await callerAudio(text);
    event("CALLER", JSON.stringify(text));
    result.transcript.push(`CALLER: ${text}`);
    turnAudio = [];
    turnText = [];
    queue = Buffer.concat([queue, audio]);
    callerSpeaking = true;
    while (callerSpeaking) await sleep(20);
  };

  const agentDone = () => Date.now() > playbackEndsAt + 300 && Date.now() - lastAgentAudioAt > 1500;

  /** Waits for the agent's reply to finish; returns what it said. */
  const awaitReply = async (): Promise<string | null> => {
    const before = agentChunks;
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (agentChunks === before && Date.now() < deadline && !link.closed) await sleep(20);
    if (agentChunks === before) return null;
    const latency = lastAgentAudioAt && callerDoneAt ? Date.now() - callerDoneAt : 0;
    result.latencies.push(latency);
    event("latency", `${latency}ms to first agent audio`);
    while (!agentDone() && !link.closed) await sleep(50);
    const text = REMOTE || turnText.length === 0 ? await transcribe(Buffer.concat(turnAudio)) : turnText.join(" ");
    event("AGENT", JSON.stringify(text));
    result.transcript.push(`AGENT: ${text}`);
    turnAudio = [];
    turnText = [];
    return text;
  };

  const awaitHangup = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (!link.closed && Date.now() < deadline) await sleep(100);
    if (link.closed) event("hangup", "agent ended the call");
    else fail("agent didn't hang up");
  };

  link.toAgent({ event: "connected", version: "1.0.0" });
  link.toAgent({
    event: "start",
    stream_id: "sim-stream",
    start: { call_control_id: `sim-${name}-${Date.now()}`, from: "+15125550142", to: "+12137580964" },
  });

  // Greeting
  const g0 = Date.now();
  while (agentChunks === 0 && Date.now() - g0 < RESPONSE_TIMEOUT_MS && !link.closed) await sleep(20);
  if (agentChunks === 0) {
    fail("no greeting");
  } else {
    event("greeting", `first audio ${Date.now() - g0}ms after stream start`);
  }

  try {
    if (Array.isArray(script)) {
      for (let i = 0; i < script.length && result.failures.length === 0; i++) {
        const step = script[i];
        if ("sayDuringGreeting" in step) {
          await sleep(500);
          await speak(step.sayDuringGreeting);
          while (!agentDone()) await sleep(50); // greeting finishes
          turnAudio = [];
          turnText = [];
          if ((await awaitReply()) === null) fail("speech during the greeting got no reply");
        } else if ("say" in step) {
          if (i === 0 || !("thenImmediately" in (script[i - 1] as any) && (script[i - 1] as any).thenImmediately)) {
            while (!agentDone()) await sleep(50);
            await sleep(400);
          }
          await speak(step.say);
          if (step.thenImmediately) {
            await sleep(1200); // a thinking pause, mid-sentence
            continue;
          }
          if ((await awaitReply()) === null) fail(`no reply to ${JSON.stringify(step.say)}`);
        } else if ("silence" in step) {
          while (!agentDone()) await sleep(50);
          const end = Date.now() + step.silence;
          while (Date.now() < end && !link.closed) {
            if (agentChunks > 0 && !agentDone()) {
              await awaitReply();
            }
            await sleep(100);
          }
        } else if ("expectHangup" in step) {
          await awaitHangup(10000);
        }
      }
    } else {
      // LLM-played caller, reacting to what the agent actually said.
      const history: Array<{ role: string; content: string }> = [
        {
          role: "system",
          content: `${script.persona}\n\nYou are the CALLER on a phone call with JETZT's phone assistant. Reply with only the words you'd say out loud next — no quotes, no stage directions. If the agent's audio was garbled or empty, react like a real caller would.`,
        },
      ];
      while (!agentDone()) await sleep(50);
      const greetingText = REMOTE ? await transcribe(Buffer.concat(turnAudio)) : turnText.join(" ");
      history.push({ role: "user", content: greetingText || "(greeting)" });
      result.transcript.push(`AGENT: ${greetingText}`);
      for (let turn = 0; turn < script.maxTurns && !link.closed; turn++) {
        const line = (await chat("gpt-4o-mini", history)).trim();
        history.push({ role: "assistant", content: line });
        await sleep(300);
        await speak(line);
        const reply = await awaitReply();
        if (reply === null) {
          if (link.closed) break;
          fail(`no reply to ${JSON.stringify(line)}`);
          break;
        }
        history.push({ role: "user", content: reply });
        if (/\b(bye|goodbye)\b/i.test(line)) {
          await awaitHangup(8000);
          break;
        }
      }
    }
  } finally {
    clearInterval(pump);
    link.close();
  }

  // Reviewer
  try {
    const review = await chat(
      "gpt-4o",
      [
        {
          role: "system",
          content:
            "You review phone calls handled by JETZT's AI phone assistant. JETZT's business details are NOT configured yet, so the right behavior for questions about offerings/prices is to say the team will confirm and offer a message or call — inventing facts is a serious error. Judge: (1) Did it respond sensibly to every caller turn? (2) Brevity and natural spoken style. (3) Accuracy — any invented facts? (4) Engagement — did it move the caller toward a useful next step? (5) Task success (booking/message/cancel done correctly, emails read back correctly). Reply as JSON: {\"score\": 1-10, \"problems\": [short specific strings], \"best_fix\": \"one concrete change to the agent's instructions\"}",
        },
        { role: "user", content: result.transcript.join("\n") },
      ],
      true
    );
    result.review = review;
  } catch (err) {
    result.review = `review failed: ${(err as Error).message}`;
  }
  return result;
}

(async () => {
  if (!REMOTE) {
    const mod = await import(pathToFileURL(path.resolve("src/telnyx/mediaStream.ts")).href);
    inProcessHandler = mod.handleMediaStreamConnection;
  }
  const all = { ...SCRIPTED, ...PERSONAS };
  const names = scenarioArg === "all" ? Object.keys(all) : scenarioArg.split(",");
  const results: CallResult[] = [];
  for (const n of names) {
    if (!all[n]) {
      realLog(`unknown scenario ${n}; have: ${Object.keys(all).join(", ")}`);
      continue;
    }
    results.push(await runCall(n, all[n]));
  }

  realLog("\n=============== summary ===============");
  for (const r of results) {
    const l = [...r.latencies].sort((a, b) => a - b);
    const lat = l.length ? `median ${l[Math.floor(l.length / 2)]}ms, worst ${l[l.length - 1]}ms` : "";
    let score = "";
    try {
      const j = JSON.parse(r.review ?? "{}");
      score = `review ${j.score}/10`;
      realLog(`${r.name.padEnd(22)} ${(r.failures.length ? "FAIL" : "ok").padEnd(5)} ${score.padEnd(13)} ${lat}`);
      for (const f of r.failures) realLog(`    fail: ${f}`);
      for (const p of j.problems ?? []) realLog(`    - ${p}`);
      if (j.best_fix) realLog(`    fix: ${j.best_fix}`);
    } catch {
      realLog(`${r.name.padEnd(22)} ${(r.failures.length ? "FAIL" : "ok").padEnd(5)} ${lat}  ${r.review}`);
    }
  }
  process.exit(0);
})();
