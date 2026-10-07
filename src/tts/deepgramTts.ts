import { config } from "../config";

/**
 * Synthesizes one chunk of agent speech with Deepgram Aura-2, streaming raw
 * mulaw/8kHz audio bytes back as they're generated — same format Telnyx
 * expects on the way out, so this can be forwarded straight into the Media
 * Streaming WebSocket without re-encoding.
 *
 * Called per sentence/response-chunk rather than per token: GPT-4o's output
 * is streamed and split on sentence boundaries by the caller (see
 * src/agent/graph.ts), and each finished sentence is handed here so audio
 * starts playing before the whole response has finished generating.
 */
// Deepgram normally answers in a few hundred ms. Without a bound, a stuck
// connection sat on undici's 10s connect timeout and then failed anyway —
// on a call that's ten seconds of silence followed by a missing sentence.
const HEADERS_TIMEOUT_MS = 3000;
const ATTEMPTS = 2;

async function requestSpeech(text: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`no response in ${HEADERS_TIMEOUT_MS}ms`)), HEADERS_TIMEOUT_MS);
    try {
      const res = await fetch(
        "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${config.deepgram.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
          signal: abort.signal,
        }
      );
      // Only the wait for headers is bounded — the body streams at its own
      // pace, and a long sentence can legitimately take longer than this.
      clearTimeout(timer);
      if (res.ok && res.body) return res;
      const errText = await res.text().catch(() => "");
      lastErr = new Error(`Deepgram TTS failed (${res.status}): ${errText}`);
      if (res.status < 500 && res.status !== 429) break; // our fault — retrying won't help
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
    console.error(`[tts] attempt ${attempt} failed for ${JSON.stringify(text)}:`, lastErr);
  }
  throw lastErr;
}

// The model spells things out hyphenated ("s-a-r-a-h"), but Aura runs
// hyphenated letters together and drops some — the caller hears "s-a-r-h".
// A/B tested by synthesizing each format and transcribing it back with two
// recognizers (Deepgram + Whisper) over sarah/klein/muhammad/oconnor/8775:
// hyphens and "S. A. R." dropped letters, "S, A, R, A, H" lost oconnor's
// double O, and groups of three ("S A R, A H") came back perfect 10/10 —
// also the shortest audio, and how people spell over the phone anyway.
// Word boundaries keep "follow-up", "e-mail" and "30-minute" untouched.
const HYPHEN_SPELLED = /\b[A-Za-z0-9](?:-[A-Za-z0-9])+\b/g;

export function prepareForSpeech(text: string): string {
  return text.replace(HYPHEN_SPELLED, (run) => {
    const chars = run.split("-").map((c) => c.toUpperCase());
    const groups: string[] = [];
    for (let i = 0; i < chars.length; i += 3) groups.push(chars.slice(i, i + 3).join(" "));
    return groups.join(", ");
  });
}

export async function* synthesizeSpeech(text: string): AsyncGenerator<Buffer> {
  const res = await requestSpeech(prepareForSpeech(text));
  const reader = res.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) yield Buffer.from(value);
  }
}
