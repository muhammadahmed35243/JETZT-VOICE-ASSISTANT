import { verifyTelnyxSignature } from "@/telnyx/webhookVerify";
import {
  answerCall,
  startMediaStream,
  startRecording,
} from "@/telnyx/callControl";
import { createCallLog, attachRecordingUrl } from "@/calls/callLog";
import { config } from "@/config";

// Explicit Node.js runtime — this route uses Buffer/tweetnacl and talks to
// Supabase/Telnyx with the service-role key, none of which belong on the
// Edge runtime.
export const runtime = "nodejs";

const streamWsUrl = `${config.publicBaseUrl.replace(/^http/, "ws")}/api/media-stream`;

export async function POST(request: Request) {
  const signature = request.headers.get("telnyx-signature-ed25519") ?? undefined;
  const timestamp = request.headers.get("telnyx-timestamp") ?? undefined;

  // Raw text, read before any JSON parsing — Telnyx signs the exact bytes
  // it sent (see src/telnyx/webhookVerify.ts).
  const rawBody = await request.text();

  if (!verifyTelnyxSignature(Buffer.from(rawBody, "utf8"), signature, timestamp)) {
    return new Response(null, { status: 403 });
  }

  const payload = JSON.parse(rawBody);
  const eventType: string = payload?.data?.event_type;
  const eventPayload = payload?.data?.payload ?? {};
  const callControlId: string | undefined = eventPayload.call_control_id;

  // Handle the event after responding — Telnyx just needs a fast ack.
  handleEvent(eventType, eventPayload, callControlId).catch((err) => {
    console.error(`Failed handling ${eventType}:`, err);
  });

  return new Response(null, { status: 200 });
}

async function handleEvent(
  eventType: string,
  eventPayload: any,
  callControlId: string | undefined
) {
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
        // TODO: mirror the dialer's lib/storage.ts pattern (download from
        // Telnyx, re-upload to Supabase Storage) instead of storing
        // Telnyx's own URL directly — see README "Known follow-ups".
        await attachRecordingUrl(callControlId, recordingUrl);
      }
      break;
    }

    default:
      break;
  }
}
