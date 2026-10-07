# Call flow review: why the agent stops responding, plus timing and wording

Reviewed 2026-10-06 against the code and the real call transcripts in
`voice_agent_calls`.

## What the data shows

Of the last 8 calls, only one (Aug 25) had a real conversation. **Every call
since (Aug 27 to Sep 22) shows the greeting and nothing else.** The caller's
speech never produced a second turn, even on a 42-second call. Vercel runtime
logs for those calls have expired, so the exact failure on each call can't be
confirmed. Things checked today:

- STT connects fine with the app's exact parameters (live test, HTTP 101).
- `/api/health` is up.
- `agent_config.core_instructions` and `timely_info` are **both empty**. The
  agent has no information about JETZT at all.
- `knowledge_base` holds one row, and it's **wrong**: *"JETZT does not provide
  direct information or services for voice assistants specifically for
  companies…"* The post-call learning step saved the agent's own "I don't have
  info on that" from the Aug 25 call as a fact.

## Why the agent goes silent (fixed in code)

| # | Cause | Effect on a call | Fix |
|---|---|---|---|
| 1 | If the caller finished speaking while a turn was still running (very common during the 3–5s before the greeting: "Hello?"), the end-of-turn signal was **ignored and never retried**. | The caller's words sit in the buffer and the agent stays silent until the caller speaks *again*. | `turnPending` flag: the running turn picks up queued speech when it finishes. |
| 2 | `sendMedia()` **throws** when the Deepgram socket isn't open, and that throw was unhandled inside the media handler. A sticky `closed` flag also stopped all audio after any blip, even though the v5 SDK reconnects on its own. | The agent goes deaf for the rest of the call. | Check the socket state on every frame, `try/catch` the send, and retry the STT connection once at call start. |
| 3 | If an LLM or TTS turn failed, nothing was said. | Silence after the caller speaks. | Speak "Sorry, I didn't catch that. Could you say it again?" |
| 4 | `stop` and `close` both ran `finalizeCall`. | Post-call extraction ran twice, writing duplicate memory and KB facts. | `finalized` guard. |
| 5 | Turn-end relied on `UtteranceEnd`, which has a 1000ms minimum. | At least 1s of dead air on every turn, before the LLM even starts. | `speech_final` (500ms endpointing) is now the trigger. `UtteranceEnd` remains as a fallback. |

## Timing changes

- **Greeting is instant.** It's a fixed line played straight from TTS, with no
  Supabase reads or GPT-4o call in front of it. The audio is cached per
  instance, so after the first call it plays with zero synthesis latency. The
  system prompt is built in parallel and handed to the model on the caller's
  first turn.
- **Turn-end detection is about 500ms faster** (see #5).
- **Sentences no longer split mid-word.** "$3.50" and "jetzt.com" used to be
  spoken as two clips. When a tool call happened mid-reply, "check.Okay" ran
  together. Both are fixed.
- **Goodbye is about 2s faster.** The new `end_call` tool carries its own
  goodbye text, so no second model pass is needed (measured: 3.0s down to 1.0s).
- `maxTokens: 250` caps any runaway monologue.

## Wording and engagement changes

- A phone-specific base prompt (`VOICE_STYLE` in `src/agent/systemPrompt.ts`):
  - one or two sentences per reply, ending with one question
  - no "Great!" / "Of course!" on every turn
  - spoken-style numbers and dates
  - ask the caller to repeat garbled transcripts instead of answering them
  - say "One sec, let me check" before tool calls
  - steer interested prospects toward booking a call
- **Grounding.** The model was inventing answers ("Yes, JETZT offers AI
  receptionist services") with nothing to back them up. Now it checks the
  knowledge base and says the team will confirm if the answer isn't there.
- **Email capture.** The Aug 25 call took six round trips and still dropped
  letters. New rules:
  - treat "at the rate" as @
  - read the address back in chunks
  - ask the caller to re-spell only the wrong part
  - give up after two tries and fall back to the caller's phone number
- **Brand name.** Deepgram `keyterm=JETZT`. The caller's "JETZT" had been
  transcribed as "Jess".
- **Silence handling.** After 8s of silence the agent asks "Are you still
  there?". After another 8s it says goodbye and hangs up, so calls don't sit
  open until the 300s Vercel cap.
- **The agent ends the call itself** (`end_call`). Before this, it kept talking
  after goodbye and answered line noise ("Quarterback.").
- The post-call extractor no longer turns "the agent didn't know" into KB facts.

## Booking: Calendly replaced by Google Calendar

Booking now goes on the company Google Calendar. It uses the same OAuth app
as the JETZT portal (`calendar.events` scope).

- **Availability** is business hours minus events already on the calendar,
  so portal team meetings block slots too. The hours come from
  `BOOKING_TIMEZONE`, `BOOKING_HOURS`, `BOOKING_DAYS`,
  `BOOKING_SLOT_MINUTES` and `BOOKING_MIN_NOTICE_MINUTES`. The defaults are
  Mon–Fri, 9–5 Pacific, 30-minute slots, 2 hours' notice.
- **The agent confirms the caller's timezone** (guessed from the area code)
  and offers two or three slots in it.
- **Booking** re-checks that the slot is still free, then creates the event
  with a Google Meet link and emails the invite to the caller.
- **Rescheduling moves the event in place**, so the Meet link stays the same.
  Cancelling deletes the event.
- Bookings are still tracked in the `calendly_bookings` table, so no migration
  is needed. `event_uuid` now holds the Google event id.
- **Until the env vars are set, booking is off.** The agent says the team will
  reach out and takes a message instead.

Setup: add these in Vercel (and in `.env.local` to test locally):
- `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`: the same
  values as the portal's.
- `GOOGLE_CALENDAR_REFRESH_TOKEN`: a refresh token for the company Google
  account.
  - **Option A (easiest):** decrypt the token the portal already stores in its
    `integration_credentials` table.
  - **Option B:** run an OAuth consent for the account with the portal's
    client.
  - Either way, clicking "Disconnect" in the portal revokes the grant for the
    voice agent too.

## Testing every step: `scripts/simulate-call.ts`

    npx tsx scripts/simulate-call.ts                 # all scenarios, in-process
    npx tsx scripts/simulate-call.ts overlap,silence --remote https://<deployment>

The simulator plays the Telnyx side of a call with a synthesized caller voice:
real-time 20ms mulaw frames, through real STT, LLM and TTS. For each step it
prints:
- what the agent heard
- what the agent said (transcribed from its audio, so you get what the caller
  actually hears)
- the latency from the end of the caller's speech to the first agent audio

A reviewer model then grades each call and suggests one fix.

- **Scripted edge cases:**
  - `overlap`: the caller talks over the greeting
  - `mid-pause`: a pause mid-sentence
  - `silence`: the caller says nothing
  - `garbled`: line noise
- **LLM-played callers** that react to whatever the agent actually said:
  - `prospect-books-call`
  - `message-hard-email`
  - `skeptical-shopper`
  - `cancel-meeting`

Use `--remote` for timing. This machine's own network adds seconds per hop.

Simulated calls (`sim-` ids) skip every real side effect on the server (see
`src/calls/simulation.ts`). They're only accepted with the media-stream
token: a hash of `TELNYX_API_KEY`, so local and production keys must match.

**Media-stream token.** The media-stream endpoint used to accept anyone.
Telnyx is now given `?token=…` in the stream URL. For real calls a missing
token is only logged for now. Once one real call shows no "has no valid
token" warning in `vercel logs`, make it reject the connection.

## Round 3: fixes from the round-2 production run

- **Spelled-out emails were slurred.** Aura runs hyphenated letters together
  ("s-a-r-a-h" came out as "Sarh"). That's likely why the Aug 25 call looped on
  email corrections. `prepareForSpeech` in `src/tts/deepgramTts.ts` now
  rewrites hyphen-spelled runs into groups of three ("S A R, A H") just before
  synthesis. That format scored 10/10 in a synthesize-then-transcribe A/B test
  with Deepgram and Whisper. Ordinary hyphenated words are left alone.
- **The agent claimed it cancelled a meeting that wasn't cancelled.**
  `cancel_meeting` returned the soft "online booking isn't set up yet"
  message, and the model told the caller it was done anyway. Every
  non-success tool result now starts with `NOT DONE —` and says what to tell
  the caller. The prompt also has a rule: never confirm an action the tool
  result didn't confirm.
- **Fillers match the action.** Lookups still rotate "One sec." / "Let me
  check." Booking, cancelling, moving, and taking a message now get "Booking
  that now.", "Cancelling that now.", "Moving that now.", and "Writing that
  down." `update_lead_note` gets no filler. The prompt asks the model for the
  same wording.
- **Faster answers to common questions.** Hand-entered `knowledge_base` rows
  (anything not `source = 'call_extraction'`) are now in the system prompt, up
  to 6,000 characters. KB lookups had taken 4 to 6 seconds. Auto-extracted
  facts stay search-only, so a bad one can't reach every caller.
- **Simulator:** the caller now waits for 3.5s of agent quiet (was 1.5s)
  before replying, so it no longer talks over the answer after a filler.

## Round 4: full code review against the round-2 findings

- **The 97s silence wasn't network noise.** GPT-4o had no timeout (the
  OpenAI client defaults to 10 minutes) and LangChain retried up to 6 times
  with backoff. Now the response must start within 8s, with one retry; after
  that the caller hears a "say that again" line. Embeddings, used mid-call by
  KB lookups, get a 5s timeout and one retry.
- **A lost email lost the message too.** `take_message` required a valid
  email, so when read-backs failed, the caller's message couldn't be saved.
  It now accepts no email, and the team calls back on the caller's number.
  This needs migration `0002_fallback_message_optional_email.sql`.
  The prompt and the email instructions now agree on stopping after two
  tries. Before, one said two tries and the other said to keep asking.
- **A post-call failure could crash other calls.** If the post-call step
  threw (for example, the extraction model call failing), it became an
  unhandled rejection. That can kill the function instance along with any
  other call it's serving. It's now caught and logged. One failed transcript
  write no longer stops every later turn from being logged either.
- **Questions no longer wait 1.5s extra.** The unfinished-thought hold
  matched questions ending in "to?", "that?" and similar. Only a trailing
  "." or "!" counts as unfinished now.
- **A better failure line after a filler.** If "Let me check." already
  played and the turn then failed, the agent asked "Sorry, I didn't catch
  that." Now it says "Sorry, I couldn't pull that up just now."
- **Current time in local time.** The prompt now gives the time in words in
  the business's timezone instead of a UTC timestamp. During a US evening,
  UTC is already tomorrow.

## Still needed (not code)

1. **Fill in `core_instructions`** in the admin portal: what JETZT sells, who
   it's for, and pricing or next steps. This is the single biggest wording and
   engagement gap. Right now the agent can only say "the team will confirm".
2. **Delete the wrong `knowledge_base` row** (`source = 'call_extraction'`,
   "JETZT does not provide…voice assistants"). Also review the `insights`
   table for the same call.
3. **Run `supabase/migrations/0002_fallback_message_optional_email.sql`** in
   the Supabase SQL editor. Until you do, a message with no email fails to
   save, and the agent tells the caller it wasn't saved.
4. **Set the Google Calendar env vars** (`GOOGLE_CALENDAR_CLIENT_ID`,
   `_CLIENT_SECRET`, `_REFRESH_TOKEN`). Until then, booking, cancelling and
   rescheduling all return "NOT DONE".
5. Make a test call after deploying, while running `vercel logs`. The new
   `[turn] … queued` and `[stt] dropping audio` log lines show directly
   whether causes #1 and #2 were what hit the Aug 27 to Sep 22 calls.

## Next improvements worth doing

- **Barge-in.** Let the caller interrupt by stopping playback when they start
  talking. Telnyx bidirectional streaming should support clearing queued audio
  (a `clear` event), but check the exact message format against the Telnyx docs
  before building on it. Pair it with cancelling the in-flight LLM turn.
- **Start streaming in the `answer` command.** Telnyx `answer` accepts
  `stream_url` and related options. That would save the `call.answered`
  webhook round trip before audio starts. Check which bidirectional options
  `answer` accepts first.
- **Pronunciation.** Check how Aura says "JETZT". If it's wrong, spell it
  phonetically in `GREETING` and in TTS input.
- The first model call on a cold instance took about 3s to first token in
  testing; warm turns took about 1.2s. Consider `gpt-4o-mini` for simple turns,
  or keeping instances warm.
