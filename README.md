# JETZT Voice Agent — backend

Inbound AI voice agent for JETZT. Answers calls to the existing number
(`+1 (213) 758-0964`, shared with the outbound cold dialer — see
`docs/what-already-done-in-dialer.md`), runs Telnyx Call Control + Media
Streaming into Deepgram STT → LangGraph (GPT-4o + tools) → Deepgram TTS.
Full design in `docs/voice-agent-plan.md`.

This repo is the **voice backend only** — the always-on service that holds
the live per-call WebSocket. The admin portal (Next.js on Vercel) is a
separate app, per the plan's "two hosting shapes" split.

## Status

Scaffolded and typechecks/builds cleanly (`npm run build`, `npm run
typecheck`). Not yet run against a real call — see "Known follow-ups"
below before treating this as production-ready.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - Telnyx: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` (both from the existing
     JETZT Telnyx account)
   - **New Telnyx Call Control connection** — create one in the Telnyx
     portal (Voice → Connections → Call Control), separate from the
     dialer's `Cold Dialer` TeXML connection. Put its id in
     `TELNYX_CALL_CONTROL_CONNECTION_ID`, and point `+12137580964`'s
     **inbound** routing at it (Numbers → My Numbers → this number →
     Connection). This does not affect the dialer's outbound calls — see
     docs/voice-agent-plan.md "Reusing the existing number".
   - `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
     (direct Postgres connection string — used by the LangGraph
     checkpointer)
   - `CALENDLY_API_KEY` / `CALENDLY_EVENT_TYPE_URI` — pending, see the
     plan's "Pre-build checklist". The Calendly tool degrades gracefully
     (tells the agent to take a message instead) until these are set.
   - `PUBLIC_BASE_URL` — this service's public URL, for Telnyx's webhook
     callbacks (e.g. an `https://*.fly.dev` URL once deployed, or an ngrok
     URL for local testing against a real call)
3. Run the migration in `supabase/migrations/0001_voice_agent_init.sql`
   against the Supabase project (`supabase db push`, or paste it into the
   SQL editor).
4. `npm run dev` for local development. Telnyx needs a publicly reachable
   URL to send webhooks and open the media stream to — use `ngrok http
   8080` (or similar) and set `PUBLIC_BASE_URL` to that during local
   testing.
5. Point the new Call Control connection's webhook URL at
   `{PUBLIC_BASE_URL}/telnyx/webhook`.

## Deploy

`fly launch` once (creates the app from `fly.toml`), then `fly deploy` for
subsequent deploys. Set the same env vars as secrets: `fly secrets set
KEY=value ...`.

## Known follow-ups

- **Verify the Media Streaming wire format against a real call.** The
  inbound message shape and the outbound `{event: "media", ...}` frame
  Telnyx expects back (`src/telnyx/mediaStream.ts`,
  `src/telnyx/callControl.ts`) are built from Telnyx's docs, not a live
  test — confirm audio actually flows both directions before relying on
  this.
- **Business-data tool schema** (`src/agent/tools/businessData.ts`) assumes
  a `leads` table with `phone_number` / `notes` columns. Update it once the
  dialer's actual schema is confirmed (docs/voice-agent-plan.md
  "Pre-build checklist").
- **Recording storage** currently saves Telnyx's own recording URL
  directly (`call.recording.saved` handler in `src/server.ts`). The plan
  calls for mirroring the dialer's `lib/storage.ts` pattern (download +
  re-upload to Supabase Storage) instead — not yet ported since that file
  lives in the dialer's repo, not this one.
- **LangGraph turn timing is sentence-level, not token-level.** Each turn
  runs to completion (including any tool calls) before TTS starts, then
  streams sentence-by-sentence. A turn with a slow tool call will have a
  slower time-to-first-audio than one without. See the comment in
  `src/telnyx/mediaStream.ts`.
- **Barge-in is not implemented** — matches the plan's decision to ship v1
  without it.
- **Calendly credentials** — pending.
