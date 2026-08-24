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
export async function* synthesizeSpeech(text: string): AsyncGenerator<Buffer> {
  const res = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${config.deepgram.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Deepgram TTS failed (${res.status}): ${errText}`);
  }

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) yield Buffer.from(value);
  }
}
