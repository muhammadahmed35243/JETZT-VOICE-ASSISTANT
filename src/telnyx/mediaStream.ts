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
  // Nullable: openSttStream() is async (it awaits the Deepgram connection
  // actually opening), so there's a real window between the session being
  // created and the STT connection being ready — 'media' frames arriving
  // in that window are dropped rather than crashing on a null connection.
  stt: Awaited<ReturnType<typeof openSttStream>> | null;
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
  let mediaMessageCount = 0;
  let rawMessageCount = 0;

  ws.on("message", async (raw) => {
    rawMessageCount++;
    if (rawMessageCount === 1 || rawMessageCount % 100 === 0) {
      console.log(`[ws] raw 'message' event #${rawMessageCount} received (before parsing)`);
    }

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

        const newSession: CallSession = {
          callControlId,
          callerPhone,
          streamId,
          isFirstTurn: true,
          utteranceBuffer: [],
          turnInFlight: false,
          stt: null,
        };
        session = newSession;

        // STT connecting and the greeting are independent — run them
        // concurrently, and never let an STT failure block the greeting.
        // Awaiting openSttStream() before the greeting was the actual bug
        // just found: it can reject (confirmed — the 1006 issue), and an
        // unhandled rejection there meant the greeting never ran at all,
        // not even degraded. STT failing now only means the caller's
        // speech won't be heard; the agent still greets either way.
        const sttPromise = openSttStream({
          onFinalTranscript: (text) => {
            newSession.utteranceBuffer.push(text);
          },
          onUtteranceEnd: () => {
            waitUntil(handleUtteranceEnd(session, ws));
          },
          onError: (err) => console.error("Deepgram STT error:", err),
        })
          .then((stt) => {
            newSession.stt = stt;
          })
          .catch((err) => {
            console.error(`[stt] failed to open connection for ${callControlId}:`, err);
          });

        await Promise.all([sttPromise, runAgentTurn(newSession, ws, null)]);
        break;
      }

      case "media": {
        mediaMessageCount++;
        if (mediaMessageCount === 1 || mediaMessageCount % 100 === 0) {
          console.log(`[ws] 'media' message #${mediaMessageCount}, session=${session ? "present" : "NULL"}`);
        }
        if (session?.stt) {
          session.stt.sendAudio(Buffer.from(msg.media.payload, "base64"));
        }
        break;
      }

      case "stop": {
        if (session) {
          session.stt?.close();
          await finalizeCall(session);
        }
        break;
      }

      default:
        // No default case existed before this — an unrecognized event.event
        // value would silently vanish with zero logging, which is
        // indistinguishable from audio never arriving at all. A real call
        // billed 32s of inbound media streaming on Telnyx's side while we
        // logged not one 'media' message — this is here to find out
        // whether that's because the event name differs from what we
        // expect, rather than guessing further.
        console.log(`[ws] unhandled event type ${JSON.stringify(msg.event)}: %j`, msg);
        break;
    }
  });

  ws.on("close", () => {
    if (session) {
      session.stt?.close();
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
 * Runs one LangGraph turn, speaking sentences as they stream in rather
 * than waiting for the full reply — this is what actually cuts
 * time-to-first-audio, not just chunking a finished reply into sentences
 * afterward. runTurn() streams text deltas via onDelta; as soon as a
 * complete sentence appears in the accumulated buffer, it's handed to
 * speakSentence(). Synthesis+send for each sentence is chained onto
 * speakQueue rather than fired concurrently — sentence order on the wire
 * has to match spoken order, and this is the simple way to guarantee that
 * without a separate reordering buffer. It does mean sentence 2 doesn't
 * start synthesizing until sentence 1's audio has fully sent, which is a
 * real (smaller) latency cost against true parallel synthesis — worth
 * revisiting if time-to-first-audio is still not good enough after this.
 */
async function runAgentTurn(
  session: CallSession,
  ws: MediaSocket,
  userText: string | null
) {
  session.turnInFlight = true;
  console.log(`[turn] starting for ${session.callControlId}, isFirstTurn=${session.isFirstTurn}, userText=${JSON.stringify(userText)}`);

  let sentenceBuffer = "";
  let speakQueue: Promise<void> = Promise.resolve();
  let sentenceCount = 0;

  const enqueueSentence = (sentence: string) => {
    sentenceCount++;
    console.log(`[turn] sentence ${sentenceCount} ready for ${session.callControlId}: ${JSON.stringify(sentence)}`);
    speakQueue = speakQueue.then(() => speakSentence(session, ws, sentence));
  };

  try {
    const responseText = await runTurn({
      callControlId: session.callControlId,
      callerPhone: session.callerPhone,
      userText,
      isFirstTurn: session.isFirstTurn,
      onDelta: (delta) => {
        sentenceBuffer += delta;
        const { sentences, remainder } = extractReadySentences(sentenceBuffer);
        sentenceBuffer = remainder;
        for (const sentence of sentences) enqueueSentence(sentence);
      },
    });
    session.isFirstTurn = false;
    console.log(`[turn] model finished responding for ${session.callControlId}: ${JSON.stringify(responseText)}`);

    // Trailing text with no terminal punctuation never got picked up by
    // extractReadySentences above — flush it as the final sentence.
    if (sentenceBuffer.trim()) enqueueSentence(sentenceBuffer.trim());

    if (userText) await appendTranscriptTurn(session.callControlId, "caller", userText);
    await appendTranscriptTurn(session.callControlId, "agent", responseText);

    await speakQueue;
    console.log(`[turn] all ${sentenceCount} sentence(s) spoken for ${session.callControlId}`);
  } catch (err) {
    console.error(`Turn failed for call ${session.callControlId}:`, err);
  } finally {
    session.turnInFlight = false;
  }
}

/** Pulls every complete sentence out of a growing buffer, leaving any
 *  trailing partial sentence behind for the next call. */
function extractReadySentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let remainder = buffer;
  let match: RegExpMatchArray | null;
  while ((match = remainder.match(/^([^.!?]*[.!?]+)\s*/))) {
    const sentence = match[1].trim();
    if (sentence) sentences.push(sentence);
    remainder = remainder.slice(match[0].length);
  }
  return { sentences, remainder };
}

async function speakSentence(session: CallSession, ws: MediaSocket, sentence: string) {
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
