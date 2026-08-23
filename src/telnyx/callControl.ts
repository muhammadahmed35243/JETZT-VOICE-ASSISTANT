import { config } from "../config.js";

const BASE_URL = "https://api.telnyx.com/v2";

async function callControlAction(
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(
    `${BASE_URL}/calls/${callControlId}/actions/${action}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.telnyx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Telnyx ${action} failed (${res.status}) for ${callControlId}: ${text}`
    );
  }

  return res.json();
}

export function answerCall(callControlId: string) {
  return callControlAction(callControlId, "answer");
}

export function hangupCall(callControlId: string) {
  return callControlAction(callControlId, "hangup");
}

/**
 * Starts bidirectional Media Streaming to our WebSocket endpoint. Called
 * once we've received call.answered for this call — see src/server.ts.
 *
 * rtp + PCMU keeps audio in Deepgram's native 8kHz mu-law format both
 * directions, so nothing needs transcoding on the way in or out. Field
 * names verified against Telnyx's Call Control / bidirectional streaming
 * docs (Aug 2026) — the exact media-frame message schema below is the one
 * part worth double-checking against a real call before trusting it, since
 * it wasn't possible to confirm byte-for-byte from docs alone.
 */
export function startMediaStream(callControlId: string, streamUrl: string) {
  return callControlAction(callControlId, "streaming_start", {
    stream_url: streamUrl,
    stream_track: "inbound_track",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    stream_bidirectional_target_legs: "self",
    stream_bidirectional_sampling_rate: 8000,
  });
}

export function stopMediaStream(callControlId: string) {
  return callControlAction(callControlId, "streaming_stop");
}

/**
 * Mirrors the dialer's approach of driving recording explicitly rather than
 * relying on connection/profile-level auto-record (see
 * docs/what-already-done-in-dialer.md §3) — dual channel so caller and
 * agent end up on separate tracks in the saved file.
 */
export function startRecording(callControlId: string) {
  return callControlAction(callControlId, "record_start", {
    format: "mp3",
    channels: "dual",
  });
}

export function stopRecording(callControlId: string) {
  return callControlAction(callControlId, "record_stop");
}
