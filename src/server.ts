import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";

import { config } from "./config.js";
import { verifyTelnyxSignature } from "./telnyx/webhookVerify.js";
import {
  answerCall,
  startMediaStream,
  startRecording,
} from "./telnyx/callControl.js";
import { handleMediaStreamConnection } from "./telnyx/mediaStream.js";
import { createCallLog, attachRecordingUrl } from "./calls/callLog.js";

const app = express();

const streamWsUrl = `${config.publicBaseUrl.replace(/^http/, "ws")}/media-stream`;

app.get("/health", (_req, res) => res.json({ ok: true }));

// Raw body needed here specifically — Telnyx signs the exact bytes it
// sent (see src/telnyx/webhookVerify.ts), so this must stay unparsed
// until after signature verification.
app.post(
  "/telnyx/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.header("telnyx-signature-ed25519");
    const timestamp = req.header("telnyx-timestamp");
    const rawBody = req.body as Buffer;

    if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
      res.sendStatus(403);
      return;
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const eventType: string = payload?.data?.event_type;
    const eventPayload = payload?.data?.payload ?? {};
    const callControlId: string | undefined = eventPayload.call_control_id;

    res.sendStatus(200); // ack immediately, handle the event after

    try {
      switch (eventType) {
        case "call.initiated": {
          if (eventPayload.direction !== "incoming" || !callControlId) break;
          await answerCall(callControlId);
          await createCallLog(callControlId, eventPayload.from ?? "unknown");
          break;
        }

        case "call.answered": {
          if (!callControlId) break;
          await Promise.all([
            startMediaStream(callControlId, streamWsUrl),
            startRecording(callControlId),
          ]);
          break;
        }

        case "call.recording.saved": {
          if (!callControlId) break;
          const recordingUrl =
            eventPayload.recording_urls?.mp3 ?? eventPayload.recording_urls?.wav;
          if (recordingUrl) {
            // TODO: mirror the dialer's lib/storage.ts pattern — download
            // from Telnyx and re-upload to Supabase Storage, rather than
            // storing Telnyx's own URL directly (see
            // docs/what-already-done-in-dialer.md §4).
            await attachRecordingUrl(callControlId, recordingUrl);
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error(`Failed handling ${eventType}:`, err);
    }
  }
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });
wss.on("connection", handleMediaStreamConnection);

server.listen(config.port, () => {
  console.log(`jetzt-voice-agent listening on :${config.port}`);
  console.log(`media stream ws: ${streamWsUrl}`);
});
