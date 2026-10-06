import type { WebSocket as MediaSocket } from "ws";
import { waitUntil } from "@vercel/functions";
import { openSttStream } from "../stt/deepgramStt";
import { synthesizeSpeech } from "../tts/deepgramTts";
import { runTurn } from "../agent/graph";
import { buildSystemPrompt, GREETING } from "../agent/systemPrompt";
import { consumePendingGoodbye, END_CALL_TOOL_NAME } from "../agent/tools/endCall";
import { hangupCall } from "./callControl";
import { isSimulatedCall } from "../calls/simulation";
import { extractAndApply } from "../memory/extraction";
import {
  appendTranscriptTurn,
  finalizeCallLog,
  getTranscriptText,
} from "../calls/callLog";

// `experimental_upgradeWebSocket` (from `@vercel/functions`) hands its
// handler a real `ws` package WebSocket — confirmed from that package's own
// .d.ts, not assumed — so this can use the actual `ws` type directly rather
// than a defensive duck-typed stand-in.
export type { MediaSocket };

// How long the caller can stay silent after the agent finishes talking
// before it checks in. Measured from when the audio finishes *playing*,
// not from when it finished sending (see playbackEndsAt).
const SILENCE_REPROMPT_MS = 8000;
const SILENCE_PROMPTS = [
  "Are you still there?",
  "I'll let you go for now. Feel free to call back anytime. Bye!",
];
const TURN_FAILED_REPLY = "Sorry, I didn't catch that. Could you say it again?";
// Played when the model goes straight to a tool call without saying
// anything, so the caller isn't left in silence while it runs. Rotated so
// it doesn't sound canned on a call with several lookups.
const TOOL_FILLERS = ["One sec.", "Let me check.", "Just a moment."];

// mulaw at 8kHz is one byte per sample: 8 bytes per millisecond of audio.
const MULAW_BYTES_PER_MS = 8;

interface CallSession {
  callControlId: string;
  callerPhone: string;
  streamId?: string;
  ws: MediaSocket;
  utteranceBuffer: string[];
  // Nullable: openSttStream() is async (it awaits the Deepgram connection
  // actually opening), so there's a real window between the session being
  // created and the STT connection being ready — 'media' frames arriving
  // in that window are dropped rather than crashing on a null connection.
  stt: Awaited<ReturnType<typeof openSttStream>> | null;
  turnInFlight: boolean;
  // The caller finished an utterance while a turn was already running.
  // This used to be dropped: the text sat in the buffer and nothing
  // replied until the caller spoke *again* — the "agent just stops
  // responding" symptom. Now the in-flight turn picks it up when it ends.
  turnPending: boolean;
  // System prompt, built in parallel with the greeting playing. Handed to
  // the model on the caller's first turn, then cleared.
  opening: Promise<{ systemPrompt: string; greeting: string }> | null;
  // Telnyx buffers what we send and plays it in real time, and we send
  // much faster than real time — so "done sending" isn't "caller has heard
  // it". This tracks when the caller actually finishes hearing it.
  playbackEndsAt: number;
  silenceTimer?: ReturnType<typeof setTimeout>;
  silencePromptsGiven: number;
  fillersGiven: number;
  ended: boolean;
  finalized: boolean;
  // Transcript appends are read-modify-write on one jsonb column — chained
  // so two close-together turns can't overwrite each other.
  transcriptWrites: Promise<void>;
}

/**
 * One Telnyx Media Streaming WebSocket per call. Message shape (event,
 * start.call_control_id, media.payload, etc.) follows Telnyx's documented
 * format, closely mirroring Twilio's Media Streams protocol.
 */
function rawDataToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

export function handleMediaStreamConnection(ws: MediaSocket, { authenticated }: { authenticated: boolean }) {
  let session: CallSession | null = null;
  let mediaMessageCount = 0;

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(rawDataToString(raw));
    } catch (err) {
      console.error("[ws] failed to parse incoming message:", err);
      return;
    }

    switch (msg.event) {
      case "connected":
        console.log("[ws] Telnyx sent 'connected'");
        break;

      case "start": {
        console.log(`[ws] Telnyx sent 'start': %j`, msg.start);
        const callControlId: string = msg.start.call_control_id;
        const callerPhone: string = msg.start.from ?? "unknown";
        const streamId: string = msg.start.stream_id ?? msg.stream_sid;

        if (!authenticated) {
          if (isSimulatedCall(callControlId)) {
            console.log(`[ws] rejecting unauthenticated simulated call ${callControlId}`);
            ws.close();
            return;
          }
          // Log-only for real calls until a real call confirms Telnyx
          // passes the stream_url query string through — then this should
          // close the socket too.
          console.warn(`[ws] media stream for ${callControlId} has no valid token`);
        }

        const newSession: CallSession = {
          callControlId,
          callerPhone,
          streamId,
          ws,
          utteranceBuffer: [],
          turnInFlight: false,
          turnPending: false,
          stt: null,
          opening: buildSystemPrompt(callerPhone, callControlId).then((systemPrompt) => ({
            systemPrompt,
            greeting: GREETING,
          })),
          playbackEndsAt: 0,
          silencePromptsGiven: 0,
          fillersGiven: 0,
          ended: false,
          finalized: false,
          transcriptWrites: Promise.resolve(),
        };
        session = newSession;

        // STT connecting and the greeting are independent — run them
        // concurrently, and never let an STT failure block the greeting.
        await Promise.all([connectStt(newSession, ws), speakGreeting(newSession, ws)]);
        break;
      }

      case "media": {
        mediaMessageCount++;
        if (mediaMessageCount === 1 || mediaMessageCount % 500 === 0) {
          console.log(`[ws] 'media' message #${mediaMessageCount}, session=${session ? "present" : "NULL"}`);
        }
        if (session?.stt) {
          session.stt.sendAudio(Buffer.from(msg.media.payload, "base64"));
        }
        break;
      }

      case "stop": {
        if (session) {
          endSession(session);
          await finalizeCall(session);
        }
        break;
      }

      default:
        console.log(`[ws] unhandled event type ${JSON.stringify(msg.event)}: %j`, msg);
        break;
    }
  });

  ws.on("close", () => {
    if (session) {
      endSession(session);
      // The connection is tearing down right as this fires — without
      // waitUntil() this is the most likely spot in the app to get
      // silently killed by Vercel.
      waitUntil(finalizeCall(session));
    }
  });
}

function endSession(session: CallSession) {
  session.ended = true;
  clearSilenceTimer(session);
  session.stt?.close();
}

/** Opens STT, retrying once — a call where this fails is a call where the
 *  agent greets and then can't hear anything, so one retry is cheap
 *  insurance against a transient connect failure. */
async function connectStt(session: CallSession, ws: MediaSocket) {
  for (let attempt = 1; attempt <= 2 && !session.ended; attempt++) {
    try {
      session.stt = await openSttStream({
        onFinalTranscript: (text) => {
          session.utteranceBuffer.push(text);
        },
        onCallerSpeech: () => {
          session.silencePromptsGiven = 0;
          if (!session.turnInFlight) armSilenceTimer(session, ws);
        },
        onUtteranceEnd: () => {
          waitUntil(handleTurnEnd(session, ws));
        },
        onError: (err) => console.error("Deepgram STT error:", err),
      });
      return;
    } catch (err) {
      console.error(`[stt] connect attempt ${attempt} failed for ${session.callControlId}:`, err);
    }
  }
}

async function speakGreeting(session: CallSession, ws: MediaSocket) {
  await speakFixed(session, ws, GREETING);
  logTranscript(session, "agent", GREETING);
  armSilenceTimer(session, ws);
}

async function handleTurnEnd(session: CallSession, ws: MediaSocket) {
  if (session.ended) return;
  if (session.turnInFlight) {
    if (session.utteranceBuffer.length > 0) {
      console.log(`[turn] caller finished speaking mid-turn for ${session.callControlId} — queued: %j`, session.utteranceBuffer);
      session.turnPending = true;
    }
    return;
  }

  while (session.utteranceBuffer.length > 0 && !session.ended) {
    session.turnPending = false;
    const userText = session.utteranceBuffer.join(" ");
    session.utteranceBuffer = [];
    clearSilenceTimer(session);
    console.log(`[turn] caller said: ${JSON.stringify(userText)} (call ${session.callControlId})`);
    await runAgentTurn(session, ws, userText);
    // Text left in the buffer without turnPending is a caller still
    // mid-sentence — their own turn-end signal will come and pick it up.
    if (!session.turnPending) break;
  }

  if (!session.ended && !session.turnInFlight) armSilenceTimer(session, ws);
}

/**
 * Runs one LangGraph turn, speaking sentences as they stream in rather
 * than waiting for the full reply. runTurn() streams text deltas via
 * onDelta; as soon as a complete sentence appears in the accumulated
 * buffer, it's chained onto speakQueue. Synthesis+send is sequential so
 * sentence order on the wire matches spoken order — that costs nothing
 * audible, because Telnyx is still playing sentence N while N+1 is being
 * synthesized (we send faster than real time).
 */
async function runAgentTurn(session: CallSession, ws: MediaSocket, userText: string) {
  session.turnInFlight = true;

  let sentenceBuffer = "";
  let speakQueue: Promise<void> = Promise.resolve();
  let sentenceCount = 0;
  let goodbye: string | undefined;

  const enqueueSentence = (sentence: string) => {
    sentenceCount++;
    console.log(`[turn] sentence ${sentenceCount} ready for ${session.callControlId}: ${JSON.stringify(sentence)}`);
    speakQueue = speakQueue.then(async () => {
      await sendSpeech(session, ws, synthesizeSpeech(sentence));
    });
  };

  try {
    const openingPromise = session.opening;
    session.opening = null;
    const opening = openingPromise ? await openingPromise : undefined;

    const responseText = await runTurn({
      callControlId: session.callControlId,
      userText,
      opening,
      onDelta: (delta) => {
        sentenceBuffer += delta;
        const { sentences, remainder } = extractReadySentences(sentenceBuffer);
        sentenceBuffer = remainder;
        for (const sentence of sentences) enqueueSentence(sentence);
      },
      onSilentToolCall: (toolName) => {
        if (toolName === END_CALL_TOOL_NAME) return; // carries its own goodbye
        const filler = TOOL_FILLERS[session.fillersGiven++ % TOOL_FILLERS.length];
        speakQueue = speakQueue.then(() => speakFixed(session, ws, filler));
      },
    });
    console.log(`[turn] model finished responding for ${session.callControlId}: ${JSON.stringify(responseText)}`);

    // Trailing text with no terminal punctuation never got picked up by
    // extractReadySentences above — flush it as the final sentence.
    if (sentenceBuffer.trim()) enqueueSentence(sentenceBuffer.trim());

    goodbye = consumePendingGoodbye(session.callControlId);
    if (goodbye) enqueueSentence(goodbye);

    logTranscript(session, "caller", userText);
    logTranscript(session, "agent", [responseText, goodbye].filter(Boolean).join(" "));

    await speakQueue;
  } catch (err) {
    console.error(`Turn failed for call ${session.callControlId}:`, err);
    await speakQueue;
    // Silence after the caller speaks is the worst outcome on a phone
    // call — if nothing got said, at least ask them to repeat.
    if (sentenceCount === 0) await speakFixed(session, ws, TURN_FAILED_REPLY);
  } finally {
    session.turnInFlight = false;
  }

  if (goodbye) await hangUpAfterPlayback(session);
}

/** Pulls every complete sentence out of a growing buffer, leaving any
 *  trailing partial sentence behind for the next call. A boundary needs
 *  whitespace after the punctuation — otherwise "$3.50" or "jetzt.com"
 *  got split mid-word and spoken as two separate TTS clips. */
function extractReadySentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let remainder = buffer;
  let match: RegExpMatchArray | null;
  while ((match = remainder.match(/^([\s\S]*?[.!?]+)\s+/))) {
    const sentence = match[1].trim();
    if (sentence) sentences.push(sentence);
    remainder = remainder.slice(match[0].length);
  }
  return { sentences, remainder };
}

// Audio for the fixed phrases (greeting, re-prompts, fallback) — the same
// text every call, so after the first call on a warm instance they play
// with zero TTS latency.
const fixedPhraseAudio = new Map<string, Buffer[]>();

async function speakFixed(session: CallSession, ws: MediaSocket, text: string) {
  const cached = fixedPhraseAudio.get(text);
  if (cached) {
    await sendSpeech(session, ws, cached);
    return;
  }
  const chunks: Buffer[] = [];
  async function* recording() {
    for await (const chunk of synthesizeSpeech(text)) {
      chunks.push(chunk);
      yield chunk;
    }
  }
  if (await sendSpeech(session, ws, recording())) fixedPhraseAudio.set(text, chunks);
}

/** Sends audio to Telnyx. Returns whether all of it was sent. */
async function sendSpeech(
  session: CallSession,
  ws: MediaSocket,
  audio: AsyncIterable<Buffer> | Iterable<Buffer>
): Promise<boolean> {
  let chunkCount = 0;
  try {
    for await (const chunk of audio) {
      if (ws.readyState !== ws.OPEN) {
        console.log(`[speak] socket closed for ${session.callControlId} after ${chunkCount} chunk(s)`);
        return false;
      }
      ws.send(
        JSON.stringify({
          event: "media",
          stream_id: session.streamId,
          media: { payload: chunk.toString("base64") },
        })
      );
      session.playbackEndsAt =
        Math.max(Date.now(), session.playbackEndsAt) + chunk.byteLength / MULAW_BYTES_PER_MS;
      chunkCount++;
    }
  } catch (err) {
    // Covers both synthesizeSpeech() (Deepgram fetch) and ws.send()
    // throwing — either way, stop rather than continue silently.
    console.error(`[speak] failed for ${session.callControlId} after ${chunkCount} chunk(s):`, err);
    return false;
  }
  return true;
}

function armSilenceTimer(session: CallSession, ws: MediaSocket) {
  clearSilenceTimer(session);
  if (session.ended || session.silencePromptsGiven >= SILENCE_PROMPTS.length) return;
  const delay = Math.max(0, session.playbackEndsAt - Date.now()) + SILENCE_REPROMPT_MS;
  session.silenceTimer = setTimeout(() => waitUntil(onCallerSilent(session, ws)), delay);
}

function clearSilenceTimer(session: CallSession) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  session.silenceTimer = undefined;
}

async function onCallerSilent(session: CallSession, ws: MediaSocket) {
  if (session.ended || session.turnInFlight || session.utteranceBuffer.length > 0) return;
  const text = SILENCE_PROMPTS[session.silencePromptsGiven++];
  console.log(`[turn] caller silent on ${session.callControlId} — saying ${JSON.stringify(text)}`);
  await speakFixed(session, ws, text);
  logTranscript(session, "agent", text);
  if (session.silencePromptsGiven >= SILENCE_PROMPTS.length) {
    await hangUpAfterPlayback(session);
  } else {
    armSilenceTimer(session, ws);
  }
}

async function hangUpAfterPlayback(session: CallSession) {
  session.ended = true;
  clearSilenceTimer(session);
  // Let the goodbye finish playing before cutting the line.
  await new Promise((r) => setTimeout(r, Math.max(0, session.playbackEndsAt - Date.now()) + 500));
  if (isSimulatedCall(session.callControlId)) {
    session.ws.close();
    return;
  }
  try {
    await hangupCall(session.callControlId);
  } catch (err) {
    console.error(`[call] hangup failed for ${session.callControlId}:`, err);
  }
}

function logTranscript(session: CallSession, role: "caller" | "agent", text: string) {
  if (!text || isSimulatedCall(session.callControlId)) return;
  session.transcriptWrites = session.transcriptWrites.then(() =>
    appendTranscriptTurn(session.callControlId, role, text)
  );
}

async function finalizeCall(session: CallSession) {
  // Both 'stop' and 'close' fire at the end of every call — without this
  // guard the post-call extraction ran twice, writing duplicate caller
  // memory and KB facts.
  if (session.finalized) return;
  session.finalized = true;
  if (isSimulatedCall(session.callControlId)) return;
  await session.transcriptWrites;
  const transcriptText = await getTranscriptText(session.callControlId);
  await finalizeCallLog(session.callControlId);
  if (transcriptText) {
    await extractAndApply({
      callControlId: session.callControlId,
      callerPhone: session.callerPhone,
      transcriptText,
    });
  }
}
