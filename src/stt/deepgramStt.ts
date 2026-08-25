import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { config } from "../config";

const deepgram = createClient(config.deepgram.apiKey);

export interface DeepgramStream {
  sendAudio(chunk: Buffer): void;
  close(): void;
}

/**
 * Opens a Deepgram Nova-3 live-transcription connection tuned for phone
 * audio: mulaw/8kHz matches what Telnyx sends over Media Streaming
 * directly, so no resampling step sits in the hot path. `endpointing` +
 * `utterance_end_ms` are what let us tell "caller paused mid-sentence"
 * apart from "caller is done talking, agent's turn" — onUtteranceEnd is
 * the actual turn-taking signal for handing off to the LLM.
 */
export function openSttStream({
  onFinalTranscript,
  onUtteranceEnd,
  onError,
}: {
  onFinalTranscript: (text: string) => void;
  onUtteranceEnd: () => void;
  onError: (err: unknown) => void;
}): DeepgramStream {
  const connection = deepgram.listen.live({
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    smart_format: true,
    interim_results: true,
    endpointing: 300,
    // Lowered from 1000ms — this is dead air on every single turn (caller
    // stops talking, nothing happens for this long before we even start
    // processing). 600ms trims real latency; risk is cutting off a caller
    // who pauses mid-thought for longer than that.
    utterance_end_ms: 600,
    punctuate: true,
  });

  let audioChunksSent = 0;
  let closed = false;

  // ErrorEvent/CloseEvent are Web-standard classes whose useful fields
  // (.message, .error, .code, .reason) live behind prototype getters —
  // blindly logging the object (e.g. via %j/JSON.stringify) showed
  // "{type:'error',...}" and "{}" respectively, hiding the actual reason
  // the connection died. Reading the named fields directly still works
  // (property access invokes getters regardless of enumerability), just
  // not through a generic serializer.
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

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log("[stt] Deepgram connection opened");
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    console.log(`[stt] transcript event: is_final=${data.is_final} text=${JSON.stringify(text)}`);
    if (text && data.is_final) {
      onFinalTranscript(text);
    }
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    console.log("[stt] UtteranceEnd event fired");
    onUtteranceEnd();
  });

  connection.on(LiveTranscriptionEvents.Close, (event: unknown) => {
    closed = true;
    console.log(
      `[stt] Deepgram connection closed after ${audioChunksSent} audio chunk(s) sent:`,
      describeEvent(event)
    );
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    closed = true;
    console.error("[stt] Deepgram error:", describeEvent(err));
    onError(err);
  });

  return {
    sendAudio(chunk: Buffer) {
      if (closed) {
        // Connection already died — every subsequent 'media' frame was
        // silently calling send() on a dead connection before this guard
        // existed, for the rest of the call, with no way to tell from the
        // logs that anything was wrong after the first error.
        return;
      }
      audioChunksSent++;
      if (audioChunksSent === 1 || audioChunksSent % 100 === 0) {
        console.log(`[stt] sendAudio: chunk #${audioChunksSent}, ${chunk.byteLength} bytes`);
      }
      // The SDK's send() wants an ArrayBuffer, not a Node Buffer view.
      connection.send(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      );
    },
    close() {
      console.log(`[stt] closing after ${audioChunksSent} audio chunk(s) sent total`);
      connection.requestClose();
    },
  };
}
