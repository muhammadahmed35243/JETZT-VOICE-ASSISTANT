import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../../supabase/client";
import { embedText } from "../embeddings";

export const kbLookupTool = tool(
  async ({ query }: { query: string }) => {
    const embedding = await embedText(query);
    const { data, error } = await supabase.rpc("match_knowledge_base", {
      query_embedding: embedding,
      match_count: 4,
    });

    if (error) {
      return `NOT DONE — knowledge base search failed (${error.message}). Don't guess an answer: say you'll have the team confirm, and offer to take a message.`;
    }
    if (!data || data.length === 0) {
      return "No matching knowledge base content found. Don't guess: say you'll have the team confirm, and offer to take a message or book a call.";
    }
    return data
      .map((row: { content: string; similarity: number }) => row.content)
      .join("\n---\n");
  },
  {
    name: "knowledge_base_lookup",
    description:
      "Search JETZT's knowledge base (FAQs, policies, product info) for content relevant to the caller's question. Use this before saying you don't know something.",
    schema: z.object({
      query: z.string().describe("The caller's question or topic to search for"),
    }),
  }
);
