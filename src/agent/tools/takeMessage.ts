import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../../supabase/client.js";
import { EMAIL_CONFIRMATION_INSTRUCTIONS, isPlausibleEmail } from "../emailConfirm.js";

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
    contactEmail: string;
  }) => {
    if (!isPlausibleEmail(contactEmail)) {
      return "That email doesn't look valid — spell it back to the caller and confirm before calling this tool again.";
    }

    const { error } = await supabase.from("fallback_messages").insert({
      call_control_id: callControlId,
      caller_phone: callerPhone,
      message,
      contact_email: contactEmail,
    });

    if (error) {
      return `Couldn't save the message (${error.message}) — apologize to the caller and let them know to try again later.`;
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
      contactEmail: z.string().describe("Confirmed by spelling it back before calling this tool"),
    }),
  }
);
