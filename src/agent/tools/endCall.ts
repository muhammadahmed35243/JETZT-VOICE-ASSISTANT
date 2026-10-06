import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const END_CALL_TOOL_NAME = "end_call";

// Goodbyes for calls the agent has decided to end, keyed by call id. The
// tool runs inside the graph with no handle on the live call, so it parks
// the goodbye here; the media stream handler speaks it and hangs up once
// it has finished playing.
//
// The goodbye is a tool argument (rather than the model speaking it after
// the tool returns) because the model reliably calls the tool *first* —
// a second model pass just to say "Bye!" put ~3s of dead air before it.
// The graph ends right after this tool instead (see graph.ts).
const pendingGoodbyes = new Map<string, string>();

export function consumePendingGoodbye(callControlId: string): string | undefined {
  const goodbye = pendingGoodbyes.get(callControlId);
  pendingGoodbyes.delete(callControlId);
  return goodbye;
}

export const endCallTool = tool(
  async ({ callControlId, goodbye }: { callControlId: string; goodbye: string }) => {
    pendingGoodbyes.set(callControlId, goodbye);
    return "Ending the call.";
  },
  {
    name: END_CALL_TOOL_NAME,
    description:
      "End the phone call. Use only once the conversation is clearly over — the caller has said goodbye or confirmed they need nothing else. Do not use it mid-conversation.",
    schema: z.object({
      callControlId: z.string(),
      goodbye: z.string().describe("One short, warm goodbye to say before hanging up, e.g. \"Thanks for calling, have a great day!\""),
    }),
  }
);
