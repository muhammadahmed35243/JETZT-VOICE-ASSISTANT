import type { WebSocket as MediaSocket } from "ws";
import { waitUntil } from "@vercel/functions";
import { openSttStream } from "../stt/deepgramStt";
import { synthesizeSpeech } from "../tts/deepgramTts";
import { runTurn } from "../agent/graph";
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

interface CallSession {
  callControlId: string;
  callerPhone: string;
  streamId?: string;
  isFirstTurn: boolean;
  utteranceBuffer: string[];
  stt: ReturnType<typeof openSttStream>;
  turnInFlight: boolean;
}

/**
 * One Telnyx Media Streaming WebSocket per call. Message shape (event,
 * start.call_control_id, media.payload, etc.) follows Telnyx's documented
 * format, closely mirroring Twilio's Media Streams protocol — this is the
 * one part of the integration worth checking against a real call's frames
 * before trusting blindly, since the outbound send format specifically
 * wasn't confirmable byte-for-byte from docs alone (see
 * src/telnyx/callControl.ts).
 */
function rawDataToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

export function handleMediaStreamConnection(ws: MediaSocket) {
  let session: CallSession | null = null;

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(rawDataToString(raw));
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        break;

      case "start": {
        const callControlId: string = msg.start.call_control_id;
        const callerPhone: string = msg.start.from ?? "unknown";
        const streamId: string = msg.start.stream_id ?? msg.stream_sid;

        session = {
          callControlId,
          callerPhone,
          streamId,
          isFirstTurn: true,
          utteranceBuffer: [],
          turnInFlight: false,
          stt: openSttStream({
            onFinalTranscript: (text) => {
              session?.utteranceBuffer.push(text);
            },
            onUtteranceEnd: () => {
              waitUntil(handleUtteranceEnd(session, ws));
            },
            onError: (err) => console.error("Deepgram STT error:", err),
          }),
        };

        // Agent speaks first — greet before the caller has said anything.
        await runAgentTurn(session, ws, null);
        break;
      }

      case "media": {
        if (session) {
          session.stt.sendAudio(Buffer.from(msg.media.payload, "base64"));
        }
        break;
      }

      case "stop": {
        if (session) {
          session.stt.close();
          await finalizeCall(session);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (session) {
      session.stt.close();
      // Same class of bug just found and fixed in the webhook route: the
      // connection is tearing down right as this fires, so this is the
      // highest-risk fire-and-forget spot in the whole app for getting
      // silently killed without waitUntil().
      waitUntil(finalizeCall(session));
    }
  });
}

async function handleUtteranceEnd(session: CallSession | null, ws: MediaSocket) {
  if (!session) {
    console.log("[turn] utterance-end fired with no session — ignoring");
    return;
  }
  if (session.turnInFlight) {
    console.log(`[turn] utterance-end fired while a turn was already in flight for ${session.callControlId} — ignoring, buffer had: %j`, session.utteranceBuffer);
    return;
  }
  if (session.utteranceBuffer.length === 0) {
    console.log(`[turn] utterance-end fired with an empty buffer for ${session.callControlId} — nothing to do`);
    return;
  }
  const userText = session.utteranceBuffer.join(" ");
  session.utteranceBuffer = [];
  console.log(`[turn] caller said: ${JSON.stringify(userText)} (call ${session.callControlId})`);
  await runAgentTurn(session, ws, userText);
}

/**
 * Runs one LangGraph turn and speaks the result. v1 scoping note: this
 * awaits the full turn (including any tool calls) before synthesizing any
 * audio, then streams TTS sentence-by-sentence rather than token-by-token —
 * sentence-level streaming, not the tighter token-level streaming the plan
 * called out as the ideal. Time-to-first-audio on a turn that triggers a
 * slow tool call (e.g. Calendly) will be noticeably slower than one that
 * doesn't. Worth revisiting once this is running against real calls.
 */
async function runAgentTurn(
  session: CallSession,
  ws: MediaSocket,
  userText: string | null
) {
  session.turnInFlight = true;
  console.log(`[turn] starting for ${session.callControlId}, isFirstTurn=${session.isFirstTurn}, userText=${JSON.stringify(userText)}`);
  try {
    const responseText = await runTurn({
      callControlId: session.callControlId,
      callerPhone: session.callerPhone,
      userText,
      isFirstTurn: session.isFirstTurn,
    });
    session.isFirstTurn = false;
    console.log(`[turn] model responded for ${session.callControlId}: ${JSON.stringify(responseText)}`);

    if (userText) await appendTranscriptTurn(session.callControlId, "caller", userText);
    await appendTranscriptTurn(session.callControlId, "agent", responseText);

    console.log(`[turn] calling speak() for ${session.callControlId}`);
    await speak(session, ws, responseText);
    console.log(`[turn] speak() returned for ${session.callControlId}`);
  } catch (err) {
    console.error(`Turn failed for call ${session.callControlId}:`, err);
  } finally {
    session.turnInFlight = false;
  }
}

function splitSentences(text: string): string[] {
  return (
    text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text]
  );
}

async function speak(session: CallSession, ws: MediaSocket, text: string) {
  const sentences = splitSentences(text);
  console.log(`[speak] ${sentences.length} sentence(s) for ${session.callControlId}: %j`, sentences);

  for (const sentence of sentences) {
    if (ws.readyState !== ws.OPEN) {
      console.log(`[speak] socket not OPEN before synthesizing "${sentence}" (readyState=${ws.readyState}) — stopping`);
      return;
    }

    let chunkCount = 0;
    try {
      for await (const chunk of synthesizeSpeech(sentence)) {
        if (ws.readyState !== ws.OPEN) {
          console.log(`[speak] socket closed mid-sentence for ${session.callControlId} after ${chunkCount} chunk(s)`);
          return;
        }
        ws.send(
          JSON.stringify({
            event: "media",
            stream_id: session.streamId,
            media: { payload: chunk.toString("base64") },
          })
        );
        chunkCount++;
      }
    } catch (err) {
      // Covers both synthesizeSpeech() (Deepgram fetch) and ws.send()
      // throwing — either way, stop rather than continue silently.
      console.error(`[speak] failed on "${sentence}" for ${session.callControlId} after ${chunkCount} chunk(s):`, err);
      return;
    }
    console.log(`[speak] sent ${chunkCount} chunk(s) for "${sentence}"`);
  }
}

async function finalizeCall(session: CallSession) {
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
