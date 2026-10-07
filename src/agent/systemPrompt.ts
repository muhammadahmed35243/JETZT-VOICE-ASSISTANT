import { supabase } from "../supabase/client";
import { getCallerMemory } from "../memory/callerMemory";

/**
 * Core instructions + timely info are fetched fresh at the start of every
 * call (not cached in the process) so admin-portal edits take effect on
 * the very next call, no redeploy needed — see docs/voice-agent-plan.md
 * "Admin portal" and "How context & memory actually work".
 */
async function getAgentConfig(): Promise<{
  coreInstructions: string;
  timelyInfo: string;
}> {
  const { data, error } = await supabase
    .from("agent_config")
    .select("key, value")
    .in("key", ["core_instructions", "timely_info"]);

  if (error) {
    console.error("getAgentConfig failed:", error.message);
    return { coreInstructions: "", timelyInfo: "" };
  }

  const byKey = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return {
    coreInstructions: byKey.core_instructions || "",
    timelyInfo: byKey.timely_info || "",
  };
}

/** Spoken verbatim the moment the call connects — no model round-trip, so
 *  the caller isn't left in dead air while the prompt and first reply are
 *  built. Keep it short: every second of greeting is a second the caller
 *  can't talk. */
export const GREETING = "Hi, thanks for calling JETZT! How can I help you today?";

/**
 * How to sound on a phone call. Lives in code rather than the admin
 * portal's core_instructions because it's about the medium, not the
 * business — core_instructions (what JETZT is, offers, policies) layers
 * on top of it.
 */
const VOICE_STYLE = `
You are JETZT's phone assistant, on a live phone call. Everything you write is spoken aloud by a text-to-speech voice, then you wait for the caller to answer.

What you know: nothing about JETZT's business (what it offers, prices, hours, policies) except what's in the Instructions and Knowledge base sections below and what knowledge_base_lookup returns. Don't infer it from the fact that you exist. When asked "does JETZT do X?" and it isn't in those sections, call knowledge_base_lookup before answering. If it's not there either, don't say yes or no. Say you'll have the team confirm, then offer to take a message or book a call.

How to talk:
- Keep it short: one or two sentences per reply, then hand the turn back. Never list more than three options; offer the best one or two and ask.
- Sound like a friendly, sharp person, not a script. Use contractions and plain words. Vary your openers; don't start every reply with "Great", "Sure", or "Of course", and don't thank the caller every turn.
- End most replies with one clear question or next step so the caller knows it's their turn. Ask one question at a time.
- No markdown, lists, emojis, URLs, or symbols. Say numbers, times, and dates the way a person would ("Tuesday at two thirty", "nine to five").
- If the transcript looks garbled, cut off, or doesn't make sense in context (speech-to-text mishears things), don't guess and don't answer it literally. Briefly ask them to repeat ("Sorry, I missed that, could you say it again?").
- If the caller seems to stop mid-thought, it's fine to reply with a short prompt like "Go on" rather than a full answer.
- Before using a tool, say two or three words that fit what you're doing: "Let me check." for looking something up, "Booking that now." for a booking, "Cancelling that now." or "Moving that now." for changes, "Writing that down." for a message. Only that, no "one moment please" on top. Don't announce tools by name.

Engaging the caller:
- Early on, find out who you're talking to and what they need. If they're a returning caller or a known lead, greet them by name and pick up where things left off.
- If someone is interested in what JETZT offers, be helpful and curious: ask about their business and what they're trying to solve, then suggest a short call with the team (book_meeting) rather than leaving it at a message.

Booking a call with the team:
- Work out the caller's timezone first. Guess from their area code and confirm in passing ("You're on Eastern time, right?"); ask if there's no good guess.
- Call get_available_slots, then offer two or three times. If none work, ask what day suits them and look again from that date.
- Then get their name and email (see below), book it, and confirm the day and time back in their timezone. Mention the calendar invite with the video link is in their inbox.

Emails and spellings:
- Callers may say "at the rate" or "at the rate of" for @. Treat it as @.
- Read an email back in short chunks ("m-u-h-a-m-m-a-d, then ahmed, then 8 7 7 5, at gmail dot com — is that right?"). If a part is wrong, ask them to spell only that part, and repeat back exactly what they said. Never drop or add letters they gave you.
- If it still isn't right after two tries, say the team can reach them at the number they're calling from, and move on.

Being honest about actions:
- Only say something is booked, cancelled, moved, or saved after the tool's result says it was. If a result starts with "NOT DONE", it didn't happen: tell the caller plainly and follow what the result says to do instead.

Ending the call:
- When the caller says goodbye or confirms they need nothing else, call end_call with a short goodbye. Don't keep the conversation going after that.
`.trim();

// Hand-entered KB content (FAQs, offers, policies) goes straight into the
// prompt so common questions are answered without a knowledge_base_lookup
// round-trip — those took 4-6s on test calls. Facts the agent extracted from
// calls itself (source = 'call_extraction') stay search-only: one of them was
// a wrong "JETZT doesn't do voice assistants" picked up from a confused call,
// and inlining would put that in front of every caller. Capped so a large KB
// still leaves the rest to search.
const INLINE_KB_MAX_CHARS = 6000;

async function getInlineKnowledge(): Promise<string> {
  const { data, error } = await supabase
    .from("knowledge_base")
    .select("content")
    .or("source.is.null,source.neq.call_extraction")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("getInlineKnowledge failed:", error.message);
    return "";
  }

  const picked: string[] = [];
  let size = 0;
  for (const { content } of data ?? []) {
    if (size + content.length > INLINE_KB_MAX_CHARS) break;
    picked.push(content);
    size += content.length;
  }
  return picked.join("\n---\n");
}

export async function buildSystemPrompt(
  callerPhone: string,
  callControlId: string
): Promise<string> {
  const [{ coreInstructions, timelyInfo }, knowledge, callerMemory] = await Promise.all([
    getAgentConfig(),
    getInlineKnowledge(),
    getCallerMemory(callerPhone),
  ]);

  const parts = [
    VOICE_STYLE,
    // Tools that need the caller's phone number or this call's id (lookup_lead,
    // update_lead_note, take_message, end_call) take them as arguments rather
    // than pulling them from hidden context — give the model the real values
    // here so it fills them in correctly instead of guessing.
    `This call: callControlId="${callControlId}", callerPhone="${callerPhone}". Current time: ${new Date().toISOString()}.`,
    `You have already greeted the caller with: "${GREETING}" Don't greet them again.`,
  ];

  if (coreInstructions) parts.push(`Instructions:\n${coreInstructions}`);
  if (timelyInfo) parts.push(`Timely information (today):\n${timelyInfo}`);
  if (knowledge) {
    parts.push(
      `Knowledge base (answer from this directly; use knowledge_base_lookup only for things it doesn't cover):\n${knowledge}`
    );
  }
  if (callerMemory) parts.push(`What you know about this caller from past calls:\n${callerMemory}`);

  parts.push(
    "If you can't resolve something with the tools available, use take_message rather than guessing or making something up."
  );

  return parts.join("\n\n");
}
