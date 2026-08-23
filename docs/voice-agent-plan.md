# JETZT Voice Agent — Technical Plan

Drafted 22 Aug 2026, from planning discussion, for engineering sign-off before build starts.

Inbound phone support for JETZT — one business, one number, one knowledge base, no multi-tenant complexity. Built on Telnyx, Deepgram, GPT-4o via LangGraph, and Supabase. Also doubles as a working demo of the stack.

Status: **Finalized** — one pre-build item pending (Calendly access, see bottom).

---

## Overview

A caller's audio never touches a chat UI: Telnyx connects the call, Deepgram converts speech to text and back to speech, LangGraph decides how to respond — answer directly, look something up, book a meeting, or take a message — and Supabase holds everything the agent knows and everything it learns.

**What JETZT is.** JETZT is a company. The outbound cold dialer (`docs/what-already-done-in-dialer.md`) and this inbound AI voice agent are both tools/products belonging to it, not JETZT's business identity itself. This inbound line is general-purpose, not just a callback line: it takes calls from people the dialer has already contacted (returning leads) as well as new or unrelated callers. The business-data tool is expected to extend the same `leads`/`calls` records the dialer already keeps in Supabase, rather than a separate schema — exact read/write operations to confirm against that existing schema during build.

---

## Architecture — Decided

Nine pieces, each chosen for a specific reason that came up in planning — mostly latency, phone-audio compatibility, or which pieces already share a database.

| Layer | Choice | Role |
|---|---|---|
| Telephony | Telnyx — Call Control + Media Streaming on the existing number, `+1 (213) 758-0964` | Answers the call, streams raw audio both directions |
| Speech-to-text | Deepgram Nova-3 | Streams caller audio to text — native 8kHz mu-law, ~300ms latency |
| Text-to-speech | Deepgram Aura-2 | Converts agent responses to audio, same native format |
| Orchestration | LangGraph | Conversation state, tool routing, streams responses to TTS |
| LLM | OpenAI GPT-4o | Reasoning, tool-calling, response generation |
| Embeddings | OpenAI text-embedding-3-small | Turns KB content and live queries into vectors for search |
| Data | Supabase — Postgres + pgvector | Knowledge base, business data, call logs, recordings, caller memory, auth |
| Admin portal | New pages inside the dialer's existing Next.js/Vercel app — not a separate app | Config UI, reusing the dialer's existing Google OAuth login and access control |
| Voice backend | Always-on host — Fly.io, sized for pilot volume | Holds the live per-call WebSocket, runs STT → LLM → TTS |

**Two hosting shapes, on purpose.** The admin portal — now just new pages in the dialer's existing Vercel app — only ever talks to Supabase, the same way the rest of that app already does; it never touches a live call, which is why Vercel's serverless functions are a fine fit. The voice backend holds a WebSocket open for the length of every call, sometimes several minutes of continuous audio, which serverless functions aren't built for. That's why the voice backend stays a separate always-on service rather than also living inside the dialer's Vercel app.

**Reusing the existing number.** `+1 (213) 758-0964` already exists on the Telnyx account and is currently used as the outbound caller ID for the cold-dialer app (see `docs/what-already-done-in-dialer.md`) — no new number purchase needed. This works because Telnyx treats a number's **inbound** routing (which connection answers calls *to* it) and **outbound** routing (which connection a call is placed *through*) as independent: the cold dialer already passes its `TELNYX_TEXML_CONNECTION_ID` explicitly on every outbound call, regardless of what the number's inbound assignment is. So the AI agent gets its own **Call Control** connection (not TeXML — TeXML only does static `<Say>`/`<Dial>` scripting; the agent needs raw Call Control + Media Streaming for live bidirectional audio), and the number's inbound routing gets pointed at that new connection. The existing `Cold Dialer` TeXML connection keeps handling outbound exactly as it does today — untouched.

---

## Live call flow

**The live call path** (latency-critical, needs to stay open for the whole call):

```
Caller ⇄ Telnyx (Call Control + Media Streaming) ⇄ Voice backend (always-on host)
                                                        Deepgram STT
                                                          → LangGraph (GPT-4o + tools)
                                                          → Deepgram TTS
```

**The data / config path** (no latency constraint, fine on serverless):

```
Voice backend ⇄ Supabase (Postgres + pgvector) ⇄ Admin portal (Next.js on Vercel)
```

The two paths never touch each other directly. The admin portal only reads and writes Supabase; it has no direct line to the call path at all — which is exactly why it can live on serverless Vercel while the voice backend can't.

---

## Admin portal — Decided

**Not a separate app.** The voice agent's admin features are new pages inside the dialer's existing Next.js/Vercel app, linked from its existing admin area — not a standalone app on its own domain, and not a separate login.

- **Auth.** Reuses the dialer's existing Google OAuth (Supabase Auth) login and access control as-is (see `docs/login_page_design.md` for that login page's design) — no new auth flow, allowlist table, or login screen to build for the voice agent specifically. Whatever restricts who can access the dialer's admin area today restricts this too.
- **Core instructions.** The agent's system prompt — tone, policy, how to handle X. Changes rarely, always injected into every call.
- **Timely info.** Today's hours, a temporary closure, a current promo. Also always injected into every call — deliberately kept out of the RAG-only path, so a caller doesn't miss it just because their question didn't happen to match it.
- **Knowledge base.** The larger reference material — FAQs, policies, product info — embedded and searched per query through pgvector.
- **Call history.** Every call's transcript and recording, stored in Supabase and shown per phone number — reusing the dialer's existing recording pipeline (`lib/storage.ts`: download the Telnyx recording, re-upload to Supabase Storage) rather than building a second one.
- **Review queue.** Pending insight suggestions awaiting approval — see Memory & learning below.

---

## Memory & learning — Decided

No model weights change — the agent doesn't retrain on calls. What happens instead is extraction: pull facts out after a call, store them, re-inject them later. Risk is gated by blast radius.

| Tier | Trigger | Applied |
|---|---|---|
| Per-caller memory | Facts about a specific returning caller, recognized by phone number | Auto-applied immediately — scoped to that caller only |
| Additive KB facts | New, non-conflicting facts surfaced from a call | Auto-applied, logged and reversible in the admin portal |
| Core instructions / conflicts | Anything touching agent behavior, or a KB edit that contradicts existing content | Held for admin approval before going live |

Every auto-applied change is logged with a diff and a revert option — nothing is silently invisible, even in the automatic tiers.

### How context & memory actually work

Two different things are doing work here, and they're worth keeping separate:

- **Context** — what's actually inside the LLM's prompt for one specific turn of one specific call. Temporary; it only exists for that call.
- **Memory** — what gets written to Supabase and deliberately reloaded into a *future* call's context. Persistent, crosses calls.

**1. At call start** (before the caller says anything)
- Look up the caller by phone number in a `caller_memory` table — if they're a returning caller, pull a short summary of what's known about them.
- Fetch the current core instructions + timely info fresh from Supabase — this is why admin-portal edits take effect on the very next call, with no redeploy needed.
- LangGraph opens a new state "thread" for this call, checkpointed against Supabase Postgres, keyed by call ID.

**2. Every turn during the call**
The prompt sent to GPT-4o = system prompt (instructions + timely info + caller memory, if any) + the conversation so far + tool schemas +, only when RAG fires, whatever KB chunks got retrieved for that specific question. LangGraph's checkpointer saves the growing state after each turn — that's for durability (a backend restart mid-call doesn't lose the conversation), not long-term memory. It doesn't survive past this one call on its own.

**3. After the call ends — the actual "learning" step**
A separate extraction pass reads the full transcript and pulls out: facts about this caller, new KB-worthy facts, anything suggesting the core instructions should change. Those get written using the tiered policy above.

**Cost wrinkle worth knowing:** because each turn resends the *entire* conversation so far (chat APIs are stateless per request), the prompt — and the cost — grows with every turn of a call. That's already baked into the ~$0.04/call GPT-4o estimate for an 8-turn call; it would need trimming/summarization if calls start running much longer than that.

---

## Tools — Decided

Four things LangGraph can reach for mid-call, plus one shared safety step.

- **Knowledge base lookup.** pgvector semantic search over the KB.
- **Business data.** Reads and writes JETZT's lead/call data — the same records the outbound dialer already keeps in Supabase (`leads`, `calls`). Handles both returning leads and new/unknown callers; exact operations to confirm against the existing schema during build.
- **Calendly scheduling.** `get_available_slots` + `book_meeting`, via Calendly's Scheduling API (Create Event Invitee endpoint) — books directly, no redirect to Calendly's page. Requires JETZT's Calendly account to be on a paid plan. Booking triggers Calendly's own confirmation email with the meeting link; the agent also reads the link back on the call. What a caller booked is tracked by phone number, so a later call can find it again to `cancel_meeting` or `reschedule_meeting` — Calendly has no direct API endpoint for changing an event's time, so a reschedule is a cancel-and-rebook under the hood, exposed to the caller as one action. Cancelling and rebooking both trigger Calendly's own emails the same way the original booking does.
- **Take a message (fallback).** When the agent can't resolve something: takes a message, tells the caller they'll get a response soon, and collects their email.
- **Confirm-by-spelling (shared step).** Anywhere the agent captures an email — Calendly booking, fallback message — it spells the address back letter-by-letter and gets explicit confirmation before proceeding, since STT reliably mishears domains and symbols.

---

## Cost estimate — Decided (rough)

Per 3-minute call, agent speaking roughly half the time. Real usage needs measuring once this is live — LLM cost especially depends on conversation length and how much system prompt gets resent each turn.

| Component | Basis | Per call |
|---|---|---:|
| Telnyx | Local number, Call Control (+ $1/mo per number) | $0.016 |
| Deepgram STT | Nova-3 streaming, full call duration | $0.023 |
| Deepgram TTS | Aura-2, ~1,350 characters of agent speech | $0.041 |
| GPT-4o | ~11k input / ~1.2k output tokens (estimate — 8-turn call) | ~$0.040 |
| Embeddings | Query-time only — KB is pre-embedded | negligible |
| **Total, all-in** | | **~$0.12** |

At launch (pilot volume — a few dozen calls/month), usage cost is negligible, a few dollars a month. The $1,200/month figure is the reference number at 10,000 calls/month, for when volume actually gets there — not the near-term cost. Not included in either: fixed monthly SaaS costs — Vercel, Fly.io, Supabase tier, Calendly's paid plan.

---

## Pre-build checklist

One thing left before the Calendly tool can actually be built:

- **Calendly credentials + plan confirmation.** Credentials to be provided; need to confirm the account is on a paid plan once we have access — required for the Scheduling API's direct-booking endpoint.

**Resolved in the final pass:**

- **Business domain.** JETZT is a company; the cold dialer and this AI voice agent are both tools it owns. This inbound line takes calls from both returning leads and new/unrelated callers (see Overview, above).
- **Expected call volume.** Pilot scale at launch — a few dozen calls/month.
- **Voice-backend host.** Fly.io, sized for pilot volume.
- **Barge-in / interrupt handling.** Shipping without it for v1 — default, non-interrupt behavior — revisit after real call testing.
- **Telnyx number.** Reusing the existing `+1 (213) 758-0964` rather than buying a new one (see Architecture, above).
- **Call-recording consent.** The cold dialer already has a working pattern (`<Say>` disclosure before `<Dial>`, Ed25519 webhook verification in `lib/telnyx.ts`); the AI agent's inbound flow mirrors it rather than building a parallel one.

---

## Pricing sources

Pulled 22 Aug 2026 — verify before committing budget, these move.

- [Deepgram Pricing 2026](https://diyai.io/ai-tools/speech-to-text/deepgram-pricing-2026/)
- [Deepgram Aura-2 TTS Pricing 2026](https://texttolab.com/blog/deepgram-pricing)
- [Telnyx Voice API Pricing](https://telnyx.com/pricing/voice-api)
- [Telnyx Pricing Calculator 2026](https://www.famulor.io/telnyx-calculator)
- [GPT-4o API Pricing 2026](https://kickllm.com/tools/gpt-4-pricing.html)
- [OpenAI Embedding Pricing 2026](https://embeddingcost.com/openai)
- [Calendly — Schedule Events with AI Agents](https://developer.calendly.com/schedule-events-with-ai-agents)
