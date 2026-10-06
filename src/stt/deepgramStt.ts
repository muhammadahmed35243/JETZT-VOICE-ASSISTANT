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
  onCallerSpeech,
  onUtteranceEnd,
  onError,
}: {
  onFinalTranscript: (text: string) => void;
  /** Any non-empty transcript, interim or final — "the caller is talking
   *  right now". Used to cancel the silence re-prompt timer. */
  onCallerSpeech: () => void;
  /** Fired on either turn-end signal: `speech_final` (endpointing silence,
   *  the fast path) or UtteranceEnd (word-gap fallback for noisy lines
   *  where endpointing never triggers). Can fire twice for one utterance —
   *  the caller handles that by ignoring it when the buffer is empty. */
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
    // Turn-taking: speech_final fires after this much silence, and is the
    // primary "caller is done" signal (see onUtteranceEnd). 300ms cut people
    // off mid-thought ("my email is... uh"); 500ms is still ~500ms faster
    // than waiting on UtteranceEnd's 1000ms floor.
    endpointing: 500,
    // Nova-3 keyterm prompting — without it "JETZT" was transcribed as
    // "Jess" on a real call.
    keyterm: "JETZT",
    // 1000ms is Deepgram's enforced hard minimum for this parameter —
    // confirmed directly against the API (999 -> 400 Bad Request, 1000 ->
    // 101 Switching Protocols; anything below 1000 fails the connection
    // outright, every time). An earlier "latency tune" lowered this to
    // 600ms to cut dead air after the caller stops talking, which seemed
    // reasonable but is actually invalid — that single change was the
    // real cause of every "STT connection dies / no response to the
    // caller" failure since, not the SDK version or anything else that
    // got investigated chasing it. Do not lower this again without
    // re-confirming against the API first.
    utterance_end_ms: 1000,
    punctuate: "true",
  });

  let audioChunksSent = 0;
  let sendFailures = 0;

  connection.on("open", () => {
    console.log("[stt] Deepgram connection opened");
  });

  connection.on("message", (data) => {
    if (data.type === "Results") {
      const alt = data.channel?.alternatives?.[0];
      const text = alt?.transcript?.trim();
      console.log(`[stt] transcript event: is_final=${data.is_final} text=${JSON.stringify(text)}`);
      if (text) onCallerSpeech();
      if (text && data.is_final) {
        onFinalTranscript(text);
      }
      if (data.speech_final) {
        onUtteranceEnd();
      }
    } else if (data.type === "UtteranceEnd") {
      console.log("[stt] UtteranceEnd event fired");
      onUtteranceEnd();
    }
  });

  connection.on("close", (event) => {
    console.log(
      `[stt] Deepgram connection closed after ${audioChunksSent} audio chunk(s) sent:`,
      describeEvent(event)
    );
  });

  connection.on("error", (err) => {
    console.error("[stt] Deepgram error:", describeEvent(err));
    onError(err);
  });

  connection.connect();
  await connection.waitForOpen();

  return {
    sendAudio(chunk: Buffer) {
      // v5's socket is a ReconnectingWebSocket: a dropped connection
      // reconnects on its own, so "closed" isn't permanent — a sticky
      // closed flag here used to leave the agent deaf for the rest of the
      // call after one blip. Check the live state per frame instead, and
      // never let sendMedia() throw: it throws when the socket isn't OPEN,
      // and that throw lands inside the media WebSocket's async 'message'
      // handler as an unhandled rejection.
      if (connection.readyState !== 1 /* OPEN */) {
        sendFailures++;
        if (sendFailures === 1 || sendFailures % 100 === 0) {
          console.log(`[stt] dropping audio, socket not open (readyState=${connection.readyState}, ${sendFailures} dropped)`);
        }
        return;
      }
      try {
        // Buffer already satisfies ArrayBufferView — no slicing needed.
        connection.sendMedia(chunk);
      } catch (err) {
        sendFailures++;
        console.error("[stt] sendMedia failed:", err);
        return;
      }
      audioChunksSent++;
      if (audioChunksSent === 1 || audioChunksSent % 100 === 0) {
        console.log(`[stt] sendAudio: chunk #${audioChunksSent}, ${chunk.byteLength} bytes`);
      }
    },
    close() {
      console.log(`[stt] closing after ${audioChunksSent} audio chunk(s) sent total`);
      connection.close();
    },
  };
}
