import { DeepgramClient } from "@deepgram/sdk";
import { config } from "../config";

const deepgram = new DeepgramClient({ apiKey: config.deepgram.apiKey });

export interface DeepgramStream {
  sendAudio(chunk: Buffer): void;
  close(): void;
}

// ErrorEvent/CloseEvent are Web-standard classes whose useful fields
// (.message, .error, .code, .reason) live behind prototype getters —
// blindly logging the object (e.g. via %j/JSON.stringify) hid the actual
// reason a connection died. Direct property access still works fine.
function describeEvent(event: any): Record<string, unknown> {
  return {
    type: event?.type,
    message: event?.message,
    error: event?.error?.message ?? event?.error,
    code: event?.code,
    reason: event?.reason,
    wasClean: event?.wasClean,
  };
}

/**
 * Opens a Deepgram Nova-3 live-transcription connection tuned for phone
 * audio: mulaw/8kHz matches what Telnyx sends over Media Streaming
 * directly, so no resampling step sits in the hot path. `endpointing` +
 * `utterance_end_ms` are what let us tell "caller paused mid-sentence"
 * apart from "caller is done talking, agent's turn" — the UtteranceEnd
 * message is the actual turn-taking signal for handing off to the LLM.
 *
 * Ported from @deepgram/sdk v3 to v5 — a full rewrite of the SDK's API,
 * not a patch (createClient()/.listen.live()/LiveTranscriptionEvents are
 * gone; replaced by new DeepgramClient()/.listen.v1.connect()/a single
 * discriminated 'message' event, verified against this version's actual
 * type definitions, not guessed). Upgraded specifically chasing a real
 * bug: the v3 connection was dying ~250ms into every real call with
 * WebSocket close code 1006 (abnormal closure), confirmed from
 * production logs. v5's socket is a ReconnectingWebSocket
 * (reconnectAttempts defaults to 30) — plausibly related, not confirmed
 * fixed until tested against a real call.
 */
export async function openSttStream({
  onFinalTranscript,
  onUtteranceEnd,
  onError,
}: {
  onFinalTranscript: (text: string) => void;
  onUtteranceEnd: () => void;
  onError: (err: unknown) => void;
}): Promise<DeepgramStream> {
  const connection = await deepgram.listen.v1.connect({
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    smart_format: "true",
    interim_results: "true",
    endpointing: 300,
    // Lowered from 1000ms — real dead air on every turn between the
    // caller finishing speaking and us starting to process it.
    utterance_end_ms: 600,
    punctuate: "true",
  });

  let audioChunksSent = 0;
  let closed = false;

  connection.on("open", () => {
    console.log("[stt] Deepgram connection opened");
  });

  connection.on("message", (data) => {
    if (data.type === "Results") {
      const alt = data.channel?.alternatives?.[0];
      const text = alt?.transcript?.trim();
      console.log(`[stt] transcript event: is_final=${data.is_final} text=${JSON.stringify(text)}`);
      if (text && data.is_final) {
        onFinalTranscript(text);
      }
    } else if (data.type === "UtteranceEnd") {
      console.log("[stt] UtteranceEnd event fired");
      onUtteranceEnd();
    }
  });

  connection.on("close", (event) => {
    closed = true;
    console.log(
      `[stt] Deepgram connection closed after ${audioChunksSent} audio chunk(s) sent:`,
      describeEvent(event)
    );
  });

  connection.on("error", (err) => {
    closed = true;
    console.error("[stt] Deepgram error:", describeEvent(err));
    onError(err);
  });

  connection.connect();
  await connection.waitForOpen();

  return {
    sendAudio(chunk: Buffer) {
      if (closed) {
        // Connection already died — without this guard, every subsequent
        // 'media' frame silently called send() on a dead connection for
        // the rest of the call, with nothing in the logs to indicate
        // anything was wrong after the first error.
        return;
      }
      audioChunksSent++;
      if (audioChunksSent === 1 || audioChunksSent % 100 === 0) {
        console.log(`[stt] sendAudio: chunk #${audioChunksSent}, ${chunk.byteLength} bytes`);
      }
      // Buffer already satisfies ArrayBufferView — no slicing needed.
      connection.sendMedia(chunk);
    },
    close() {
      console.log(`[stt] closing after ${audioChunksSent} audio chunk(s) sent total`);
      connection.close();
    },
  };
}
