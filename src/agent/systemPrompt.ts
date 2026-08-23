import { supabase } from "../supabase/client.js";
import { getCallerMemory } from "../memory/callerMemory.js";

/**
 * Core instructions + timely info are fetched fresh at the start of every
 * call (not cached in the process) so admin-portal edits take effect on
 * the very next call, no redeploy needed — see docs/voice-agent-plan.md
 * "Admin portal" and "How context & memory actually work".
 */
async function getAgentConfig(): Promise<{
  coreInstructions: string;
  timelyInfo: string;
}> {
  const { data, error } = await supabase
    .from("agent_config")
    .select("key, value")
    .in("key", ["core_instructions", "timely_info"]);

  if (error) {
    console.error("getAgentConfig failed:", error.message);
    return { coreInstructions: "", timelyInfo: "" };
  }

  const byKey = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return {
    coreInstructions: byKey.core_instructions || "",
    timelyInfo: byKey.timely_info || "",
  };
}

export async function buildSystemPrompt(
  callerPhone: string,
  callControlId: string
): Promise<string> {
  const [{ coreInstructions, timelyInfo }, callerMemory] = await Promise.all([
    getAgentConfig(),
    getCallerMemory(callerPhone),
  ]);

  const parts = [
    "You are JETZT's phone support agent. You are speaking with the caller over a live phone call — keep responses short, conversational, and easy to say out loud. Never use markdown, bullet points, or anything that isn't natural spoken language.",
    // Tools that need the caller's phone number or this call's id (lookup_lead,
    // update_lead_note, take_message) take them as arguments rather than
    // pulling them from hidden context — give the model the real values here
    // so it fills them in correctly instead of guessing.
    `This call: callControlId="${callControlId}", callerPhone="${callerPhone}".`,
  ];

  if (coreInstructions) parts.push(`Instructions:\n${coreInstructions}`);
  if (timelyInfo) parts.push(`Timely information (today):\n${timelyInfo}`);
  if (callerMemory) parts.push(`What you know about this caller from past calls:\n${callerMemory}`);

  parts.push(
    "If you can't resolve something with the tools available, use take_message rather than guessing or making something up."
  );

  return parts.join("\n\n");
}
