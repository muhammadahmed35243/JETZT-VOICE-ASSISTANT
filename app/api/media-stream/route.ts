import { experimental_upgradeWebSocket } from "@vercel/functions";
import { handleMediaStreamConnection } from "@/telnyx/mediaStream";

// Node.js runtime — this handler talks to Deepgram, OpenAI, and Supabase
// with server-only credentials.
export const runtime = "nodejs";
// Calls average ~3 minutes; this caps how long a single call's connection
// can stay open before Vercel forcibly closes it (see README — Fluid
// Compute + an extended maxDuration both need enabling in the Vercel
// project settings, this alone doesn't raise the platform ceiling).
export const maxDuration = 800;

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
