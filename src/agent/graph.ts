import { StateGraph, START, END, MessagesAnnotation, MemorySaver } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import { config } from "../config";
import { kbLookupTool } from "./tools/kbLookup";
import { lookupLeadTool, updateLeadNoteTool } from "./tools/businessData";
import {
  getAvailableSlotsTool,
  bookMeetingTool,
  cancelMeetingTool,
  rescheduleMeetingTool,
} from "./tools/calendar";
import { takeMessageTool } from "./tools/takeMessage";
import { endCallTool, END_CALL_TOOL_NAME } from "./tools/endCall";

const tools = [
  kbLookupTool,
  lookupLeadTool,
  updateLeadNoteTool,
  getAvailableSlotsTool,
  bookMeetingTool,
  cancelMeetingTool,
  rescheduleMeetingTool,
  takeMessageTool,
  endCallTool,
];

const model = new ChatOpenAI({
  model: "gpt-4o",
  apiKey: config.openai.apiKey,
  temperature: 0.4,
  // Hard ceiling, not the target — the system prompt asks for one or two
  // sentences. This just stops a runaway monologue on a phone line.
  maxTokens: 250,
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
  // end_call carries its own goodbye (spoken by the media stream handler),
  // so there's nothing left for the model to say — skip the extra pass.
  .addConditionalEdges("tools", (state) => {
    const last = state.messages[state.messages.length - 1];
    return last?.name === END_CALL_TOOL_NAME ? END : "agent";
  });

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
 * `opening` is only passed on the caller's first turn: the system prompt
 * plus the greeting that was already spoken (the greeting is played
 * straight from TTS without a model round-trip, so the thread has to be
 * told it happened). The checkpointer (keyed by call id) carries the rest
 * of the thread's history across subsequent turns automatically.
 */
export async function runTurn({
  callControlId,
  userText,
  opening,
  onDelta,
  onSilentToolCall,
}: {
  callControlId: string;
  userText: string;
  opening?: { systemPrompt: string; greeting: string };
  onDelta: (text: string) => void;
  /** The model started a tool call without saying anything first — the
   *  caller is about to sit through the tool's latency in silence. */
  onSilentToolCall?: (toolName: string) => void;
}): Promise<string> {
  const app = await getGraph();

  const messages = opening
    ? [new SystemMessage(opening.systemPrompt), new AIMessage(opening.greeting), new HumanMessage(userText)]
    : [new HumanMessage(userText)];

  const stream = await app.stream(
    { messages },
    { configurable: { thread_id: callControlId }, streamMode: "messages" }
  );

  let fullText = "";
  let currentMessageId: string | undefined;
  let messageHasText = false;
  let toolCallReported = false;
  let needsSeparator = false;
  for await (const item of stream) {
    const [messageChunk, metadata] = item as [
      { content: unknown; id?: string; tool_call_chunks?: Array<{ name?: string }> },
      { langgraph_node?: string },
    ];
    if (metadata.langgraph_node !== "agent") continue;

    if (messageChunk.id !== currentMessageId) {
      currentMessageId = messageChunk.id;
      messageHasText = false;
      toolCallReported = false;
      // A turn with a tool call produces two agent messages ("Let me
      // check." -> tool -> "Okay, so..."). Without a separator they ran
      // together as "check.Okay", which also kept the sentence splitter
      // from seeing a boundary there.
      needsSeparator = fullText.length > 0;
    }

    const toolName = messageChunk.tool_call_chunks?.find((c) => c.name)?.name;
    if (toolName && !messageHasText && !toolCallReported) {
      toolCallReported = true;
      onSilentToolCall?.(toolName);
    }

    const delta = typeof messageChunk.content === "string" ? messageChunk.content : "";
    if (!delta) continue;
    if (needsSeparator) {
      fullText += " ";
      onDelta(" ");
      needsSeparator = false;
    }
    messageHasText = true;
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
