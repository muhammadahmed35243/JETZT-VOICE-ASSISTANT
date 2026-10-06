import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config";
import { updateCallerMemory, getCallerMemory } from "./callerMemory";
import { recordInsight } from "./insights";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const ExtractionSchema = z.object({
  callerFacts: z
    .string()
    .describe(
      "New facts worth remembering about this specific caller for future calls (preferences, open items, context). Empty string if nothing new."
    ),
  kbFacts: z
    .array(z.string())
    .describe(
      "New, general, non-caller-specific facts surfaced this call that would help answer future callers' questions and aren't already covered — e.g. a new FAQ answer. Empty array if none."
    ),
  suggestedInstructionChange: z
    .string()
    .describe(
      "Only set this if something in the call suggests the agent's core behavior/instructions should change. Leave empty in the vast majority of calls — this is for genuine behavior gaps, not routine facts."
    ),
});

/**
 * Post-call learning pass — docs/voice-agent-plan.md "Memory & learning".
 * No model weights change; this just decides what to persist and where,
 * per the tiered policy: caller facts and KB facts apply automatically,
 * instruction changes go to the review queue instead of applying
 * themselves.
 */
export async function extractAndApply({
  callControlId,
  callerPhone,
  transcriptText,
}: {
  callControlId: string;
  callerPhone: string;
  transcriptText: string;
}): Promise<void> {
  const existingMemory = await getCallerMemory(callerPhone);

  const completion = await openai.beta.chat.completions.parse({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You review a finished support call transcript and decide what's worth remembering. Be conservative — most calls produce no KB facts and no instruction change; only flag things that are genuinely new and generally useful.\n\n" +
          // A real call's "I don't have information about that" got saved as
          // the KB fact "JETZT does not provide voice assistants", which then
          // got served back as truth on later calls.
          "kbFacts must be facts about JETZT that were stated with authority — never the agent saying it doesn't know, can't help, or has no information, and never something the caller asked about but nobody confirmed. The agent's own gaps belong in suggestedInstructionChange at most, not kbFacts.",
      },
      {
        role: "user",
        content: [
          existingMemory ? `Existing memory for this caller:\n${existingMemory}` : "No existing memory for this caller.",
          `Transcript:\n${transcriptText}`,
        ].join("\n\n"),
      },
    ],
    response_format: zodResponseFormat(ExtractionSchema, "extraction"),
  });

  const result = completion.choices[0].message.parsed;
  if (!result) return;

  if (result.callerFacts) {
    const merged = existingMemory
      ? `${existingMemory}\n${result.callerFacts}`
      : result.callerFacts;
    await updateCallerMemory(callerPhone, merged);
  }

  for (const fact of result.kbFacts) {
    await recordInsight({ kind: "kb_fact", content: fact, sourceCallId: callControlId });
  }

  if (result.suggestedInstructionChange) {
    await recordInsight({
      kind: "instruction_change",
      content: result.suggestedInstructionChange,
      sourceCallId: callControlId,
    });
  }
}
