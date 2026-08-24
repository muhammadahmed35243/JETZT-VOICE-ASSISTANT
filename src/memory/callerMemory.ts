import { supabase } from "../supabase/client";

/** Per-caller memory — lowest tier of the memory policy, auto-applied. */
export async function getCallerMemory(
  phoneNumber: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("caller_memory")
    .select("summary")
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (error) {
    console.error("getCallerMemory failed:", error.message);
    return null;
  }
  return data?.summary || null;
}

/**
 * Merges new facts into a caller's memory summary. Auto-applied immediately
 * (see docs/voice-agent-plan.md Memory & learning) — scoped to this caller
 * only, so no review gate.
 */
export async function updateCallerMemory(
  phoneNumber: string,
  newSummary: string
): Promise<void> {
  const { error } = await supabase
    .from("caller_memory")
    .upsert(
      { phone_number: phoneNumber, summary: newSummary, updated_at: new Date().toISOString() },
      { onConflict: "phone_number" }
    );

  if (error) {
    console.error("updateCallerMemory failed:", error.message);
  }
}
