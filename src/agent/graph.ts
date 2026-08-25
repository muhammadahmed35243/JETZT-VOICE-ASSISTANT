import { StateGraph, START, MessagesAnnotation, MemorySaver } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { config } from "../config";
import { buildSystemPrompt } from "./systemPrompt";
import { kbLookupTool } from "./tools/kbLookup";
import { lookupLeadTool, updateLeadNoteTool } from "./tools/businessData";
import {
  getAvailableSlotsTool,
  bookMeetingTool,
  cancelMeetingTool,
  rescheduleMeetingTool,
} from "./tools/calendly";
import { takeMessageTool } from "./tools/takeMessage";

const tools = [
  kbLookupTool,
  lookupLeadTool,
  updateLeadNoteTool,
  getAvailableSlotsTool,
  bookMeetingTool,
  cancelMeetingTool,
  rescheduleMeetingTool,
  takeMessageTool,
];

const model = new ChatOpenAI({
  model: "gpt-4o",
  apiKey: config.openai.apiKey,
  temperature: 0.4,
}).bindTools(tools);

async function agentNode(state: typeof MessagesAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

const toolNode = new ToolNode(tools);

const graphBuilder = new StateGraph(MessagesAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", toolsCondition)
  .addEdge("tools", "agent");

let compiledGraph: Awaited<ReturnType<typeof compile>> | null = null;

async function compile() {
  if (!config.supabase.dbUrl) {
    // No direct Postgres connection given — fall back to an in-memory
    // checkpointer. Conversation state survives for the life of this
    // process (fine at pilot scale on a single always-on instance) but is
    // lost on a redeploy/restart, and doesn't survive across multiple
    // instances. Set SUPABASE_DB_URL to get durable, shared state instead.
    console.warn(
      "SUPABASE_DB_URL not set — using in-memory checkpointer. Call state won't survive a restart."
    );
    return graphBuilder.compile({ checkpointer: new MemorySaver() });
  }

  // NOTE: PostgresSaver's exact API (fromConnString / setup()) is the one
  // piece here worth confirming against whatever version actually resolves
  // on `npm install` — this LangGraph JS package is younger and has moved
  // faster than the rest of this stack.
  const checkpointer = PostgresSaver.fromConnString(config.supabase.dbUrl);
  await checkpointer.setup();
  return graphBuilder.compile({ checkpointer });
}

async function getGraph() {
  if (!compiledGraph) {
    compiledGraph = await compile();
  }
  return compiledGraph;
}

/**
 * Runs one turn of the conversation, streaming text deltas out via
 * onDelta as the model generates them rather than waiting for the whole
 * reply — verified against a real streamed invocation (streamMode:
 * "messages" yields [messageChunk, metadata] tuples; metadata.langgraph_node
 * identifies which node the chunk came from) before building this, not
 * assumed from docs. Only chunks from the "agent" node carry spoken
 * content — chunks from a tool-call-deciding pass typically have empty
 * content, and tool execution itself isn't a message chunk at all, so
 * both are naturally filtered out here without special-casing them.
 *
 * `isFirstTurn` controls whether the system prompt gets included — it
 * should only ever be added once per call, at the start; the
 * checkpointer (keyed by call id) carries the rest of the thread's
 * history across subsequent turns automatically.
 */
export async function runTurn({
  callControlId,
  callerPhone,
  userText,
  isFirstTurn,
  onDelta,
}: {
  callControlId: string;
  callerPhone: string;
  /** null only valid on the first turn — lets the agent open with a greeting
   *  before the caller has said anything. */
  userText: string | null;
  isFirstTurn: boolean;
  onDelta: (text: string) => void;
}): Promise<string> {
  const app = await getGraph();

  let messages;
  if (isFirstTurn) {
    const system = new SystemMessage(await buildSystemPrompt(callerPhone, callControlId));
    messages = userText ? [system, new HumanMessage(userText)] : [system];
  } else {
    if (!userText) throw new Error("userText is required for non-first turns");
    messages = [new HumanMessage(userText)];
  }

  const stream = await app.stream(
    { messages },
    { configurable: { thread_id: callControlId }, streamMode: "messages" }
  );

  let fullText = "";
  for await (const item of stream) {
    const [messageChunk, metadata] = item as [{ content: unknown }, { langgraph_node?: string }];
    if (metadata.langgraph_node !== "agent") continue;
    const delta = typeof messageChunk.content === "string" ? messageChunk.content : "";
    if (!delta) continue;
    fullText += delta;
    onDelta(delta);
  }

  return fullText;
}

export async function getFullTranscript(callControlId: string) {
  const app = await getGraph();
  const state = await app.getState({ configurable: { thread_id: callControlId } });
  return state.values.messages;
}
