import { supabase } from "../supabase/client";
import { embedText } from "../agent/embeddings";

/**
 * Middle and top tiers of the memory/learning policy
 * (docs/voice-agent-plan.md Memory & learning):
 *  - kb_fact: additive, non-conflicting — auto-applied but logged here so
 *    it's visible and reversible in the admin portal.
 *  - instruction_change: touches core behavior, or conflicts with existing
 *    KB content — held here as "pending" until an admin approves it; never
 *    applied automatically.
 */
export async function recordInsight(params: {
  kind: "kb_fact" | "instruction_change";
  content: string;
  sourceCallId?: string;
}): Promise<void> {
  const status = params.kind === "kb_fact" ? "auto_applied" : "pending";

  if (params.kind === "kb_fact") {
    // Additive KB facts write straight into the searchable KB — logged
    // below for visibility/revert, not gated on review.
    const embedding = await embedText(params.content);
    const { error: kbError } = await supabase.from("knowledge_base").insert({
      content: params.content,
      embedding,
      source: "call_extraction",
    });
    if (kbError) {
      console.error("recordInsight: knowledge_base insert failed:", kbError.message);
    }
  }

  const { error } = await supabase.from("insights").insert({
    kind: params.kind,
    content: params.content,
    status,
    source_call_id: params.sourceCallId ?? null,
  });

  if (error) {
    console.error("recordInsight failed:", error.message);
  }
}
