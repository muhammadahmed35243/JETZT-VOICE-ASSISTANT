/**
 * Shared "confirm-by-spelling" pattern — see docs/voice-agent-plan.md
 * Tools section. This isn't a callable tool itself; it's a system-prompt
 * fragment that gets appended whenever a tool in play can capture an email
 * (Calendly booking, fallback message), plus a light validator the tools
 * use as a technical backstop. The actual "read it back and confirm"
 * behavior is the model following this instruction conversationally, not
 * code enforcing it turn-by-turn.
 */
export const EMAIL_CONFIRMATION_INSTRUCTIONS = `
When you need to capture someone's email address by voice:
1. Ask for it.
2. Read it back letter by letter, spelling out the local part and domain
   (e.g. "j-o-h-n dot smith at gmail dot com"), and ask the caller to
   confirm it's correct.
3. Only proceed (book the meeting, save the message) after they confirm.
   If they say it's wrong, ask again and repeat step 2.
Speech-to-text reliably mishears domains and symbols in emails, so do not
skip this confirmation step even if the transcript looks clean.
`.trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}
