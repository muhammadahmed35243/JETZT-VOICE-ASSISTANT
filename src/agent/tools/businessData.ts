import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../../supabase/client";

/**
 * Reads/writes the dialer's real `leads` table (see `D:\Dialer\supabase\schema.sql`
 * — columns: id, name, phone, email, company, notes, status, assigned_agent,
 * uploaded_batch_id). Column is `phone`, not `phone_number` — fixed after
 * actually reading that schema; an earlier version of this file guessed
 * wrong. One residual risk, not fully verified: how `phone` is normalized
 * on write by the dialer (e.g. with/without a `+1` prefix) — if lookups
 * start coming back empty for callers who should exist, mismatched phone
 * formatting is the first thing to check.
 */

export const lookupLeadTool = tool(
  async ({ phoneNumber }: { phoneNumber: string }) => {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("phone", phoneNumber)
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
      .eq("phone", phoneNumber);

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
