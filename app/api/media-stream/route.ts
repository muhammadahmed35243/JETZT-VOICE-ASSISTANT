import { experimental_upgradeWebSocket } from "@vercel/functions";
import { handleMediaStreamConnection } from "@/telnyx/mediaStream";

// Node.js runtime — this handler talks to Deepgram, OpenAI, and Supabase
// with server-only credentials.
export const runtime = "nodejs";
// Calls average ~3 minutes; this caps how long a single call's connection
// can stay open before Vercel forcibly closes it. 300 is the current plan's
// ceiling — Vercel rejected 800 at deploy time ("must be between 1 and 300
// seconds... upgrade your plan"), so the extended duration isn't just a
// Pro/Enterprise checkbox, it needs something beyond the base plan tier.
// 300s still covers the ~3-minute average with headroom; a call running
// past 5 minutes would get cut off — worth revisiting if that turns out to
// matter in practice.
export const maxDuration = 300;

/**
 * `experimental_upgradeWebSocket` is genuinely experimental (Vercel's own
 * naming, no deprecation guarantees) — but its handler is confirmed, from
 * @vercel/functions' own type definitions, to receive a real `ws` package
 * WebSocket, so handleMediaStreamConnection can be passed straight
 * through with no adapter/cast needed.
 */
export async function GET() {
  return experimental_upgradeWebSocket((ws) => {
    handleMediaStreamConnection(ws);
  });
}
