import OpenAI from "openai";
import { config } from "../config";

// Runs mid-call inside knowledge_base_lookup, so fail fast rather than
// leave the caller on hold (the client's default timeout is 10 minutes).
const openai = new OpenAI({ apiKey: config.openai.apiKey, timeout: 5000, maxRetries: 1 });

export async function embedText(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}
