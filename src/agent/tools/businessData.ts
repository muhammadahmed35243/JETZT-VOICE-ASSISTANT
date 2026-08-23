import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../../supabase/client.js";

/**
 * TODO(business-data-schema): the plan calls for this to read/write the
 * dialer's existing `leads` / `calls` tables (docs/voice-agent-plan.md,
 * "Pre-build checklist" is clear, but the exact column names weren't
 * available while scaffolding this repo — that schema lives with the
 * dialer app, not here. Both tools below are written defensively (they
 * catch and report a schema mismatch rather than throwing) so the agent
 * can fall back to the take-a-message tool instead of erroring out; update
 * the table/column names once the dialer's actual schema is confirmed.
 */

export const lookupLeadTool = tool(
  async ({ phoneNumber }: { phoneNumber: string }) => {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("phone_number", phoneNumber)
      .maybeSingle();

    if (error) {
      return `Lookup unavailable right now (${error.message}). Offer to take a message instead.`;
    }
    if (!data) {
      return "No existing record for this caller — treat them as a new contact.";
    }
    return JSON.stringify(data);
  },
  {
    name: "lookup_lead",
    description:
      "Look up whether this caller already exists as a lead in JETZT's system, by phone number. Use this near the start of a call.",
    schema: z.object({
      phoneNumber: z.string().describe("Caller's phone number, E.164 format"),
    }),
  }
);

export const updateLeadNoteTool = tool(
  async ({ phoneNumber, note }: { phoneNumber: string; note: string }) => {
    const { error } = await supabase
      .from("leads")
      .update({ notes: note })
      .eq("phone_number", phoneNumber);

    if (error) {
      return `Couldn't save that to the lead record (${error.message}). Offer to take a message instead.`;
    }
    return "Saved.";
  },
  {
    name: "update_lead_note",
    description:
      "Add or update a note on this caller's lead record — e.g. what they called about, an outcome, a follow-up needed.",
    schema: z.object({
      phoneNumber: z.string().describe("Caller's phone number, E.164 format"),
      note: z.string().describe("The note to save"),
    }),
  }
);
