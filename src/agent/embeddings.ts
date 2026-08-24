import OpenAI from "openai";
import { config } from "../config";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function embedText(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}
