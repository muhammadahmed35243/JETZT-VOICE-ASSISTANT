import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { isSimulatedRun } from "../../calls/simulation";
import { supabase } from "../../supabase/client";
import { EMAIL_CONFIRMATION_INSTRUCTIONS, isPlausibleEmail } from "../emailConfirm";

export const takeMessageTool = tool(
  async ({
    callControlId,
    callerPhone,
    message,
    contactEmail,
  }: {
    callControlId: string;
    callerPhone: string;
    message: string;
    contactEmail: string | null;
  }, runConfig) => {
    if (contactEmail !== null && !isPlausibleEmail(contactEmail)) {
      return "NOT DONE — that email doesn't look valid. Spell it back to the caller and confirm before calling this tool again.";
    }
    if (isSimulatedRun(runConfig)) return "Message saved. Tell the caller someone will respond soon.";

    const { error } = await supabase.from("fallback_messages").insert({
      call_control_id: callControlId,
      caller_phone: callerPhone,
      message,
      contact_email: contactEmail,
    });

    if (error) {
      return `NOT DONE — couldn't save the message (${error.message}). Don't tell the caller it was saved: apologize, and ask them to call back a bit later.`;
    }
    return "Message saved. Tell the caller someone will respond soon.";
  },
  {
    name: "take_message",
    description:
      `Use this when you can't resolve the caller's request. Take a message, tell them someone will respond soon, and capture their email. ${EMAIL_CONFIRMATION_INSTRUCTIONS}`,
    schema: z.object({
      callControlId: z.string(),
      callerPhone: z.string(),
      message: z.string().describe("What the caller needs, in their own words"),
      contactEmail: z
        .string()
        .nullable()
        .describe(
          "Confirmed by spelling it back before calling this tool. null only if it still wasn't right after two tries — the team will call back on callerPhone instead."
        ),
    }),
  }
);
