import { createHash } from "crypto";
import { config } from "../config";

/**
 * Simulated calls come from scripts/simulate-call.ts, which drives the
 * media-stream endpoint the way Telnyx does to test conversations and
 * measure real latency. They run the real STT/LLM/TTS path but must never
 * touch real data: no bookings, messages, lead edits, call logs, memory,
 * or Telnyx actions. Their call ids start with this prefix, and they're
 * only accepted on a connection carrying the media-stream token.
 */
const SIMULATED_CALL_PREFIX = "sim-";

export function isSimulatedCall(callControlId: string | undefined): boolean {
  return Boolean(callControlId?.startsWith(SIMULATED_CALL_PREFIX));
}

/** For tools: LangGraph passes the run config as a tool's second argument,
 *  and the thread id is the call id. */
export function isSimulatedRun(runConfig: { configurable?: { thread_id?: string } } | undefined): boolean {
  return isSimulatedCall(runConfig?.configurable?.thread_id);
}

/**
 * Token on the media-stream URL. The endpoint is a public WebSocket, so
 * without this anyone could open one and drive the agent (and its tools)
 * on our API keys. Derived from the Telnyx API key so there's no extra
 * secret to configure — both ends of the check live in this service.
 */
export function mediaStreamToken(): string {
  return createHash("sha256").update(`media-stream:${config.telnyx.apiKey}`).digest("hex").slice(0, 32);
}
