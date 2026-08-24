# JETZT Voice Agent — backend

![JETZT AI Voice Assistant](public/image.png)

Inbound AI voice agent for JETZT. Answers calls to the existing number
(`+1 (213) 758-0964`, shared with the outbound cold dialer — see
`docs/what-already-done-in-dialer.md`), runs Telnyx Call Control + Media
Streaming into Deepgram STT → LangGraph (GPT-4o + tools) → Deepgram TTS.
Full design in `docs/voice-agent-plan.md`.

This repo is the **voice backend only** — the always-on service that holds
the live per-call WebSocket. The admin portal is new pages inside the
dialer's existing Next.js/Vercel app, not a separate app here — see the
plan's "Admin portal" section.

## Status

Scaffolded, typechecks/builds cleanly, and **boots successfully against
real credentials** (Telnyx, Deepgram, OpenAI, Supabase, Calendly all
verified reachable — see `.env.local`). Not yet deployed anywhere, and not
yet run against a real call — see "Known follow-ups" below before treating
this as production-ready.

Done as part of setup already:
- A new Telnyx Call Control connection exists (id
  `3033141056032998992`, name "JETZT Voice Agent"), created via the API —
  separate from the dialer's `Cold Dialer` TeXML connection. Its
  `webhook_event_url` is currently a placeholder pointing at
  `https://jetzt-voice-agent.fly.dev/telnyx/webhook`; update it if the real
  Fly.io URL ends up different (`PATCH
  /v2/call_control_applications/{id}`).
- `+12137580964`'s **inbound routing has deliberately not been
  reassigned** to this new connection yet — do that only once this service
  is actually deployed and reachable, or incoming calls will go
  unanswered. The dialer's outbound calls are unaffected either way (see
  docs/voice-agent-plan.md "Reusing the existing number").
- Supabase migration has been run; RLS is enabled on every table
  (confirmed: the anon key gets `[]` back, the service-role key gets real
  rows).
- Calendly is configured with a Personal Access Token (the right choice
  for a single internal account — see docs/voice-agent-plan.md) and a
  confirmed event type ("30 Minute Meeting").

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` (matches the dialer app's
   convention) and fill in:
   - Telnyx: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` (both from the existing
     JETZT Telnyx account), `TELNYX_CALL_CONTROL_CONNECTION_ID` (see
     "Status" above if this needs recreating)
   - `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — both required; every
     Supabase read/write in this service goes through the REST API via
     `supabase-js`, which only needs these two.
   - `SUPABASE_DB_URL` — **optional.** Only used by the LangGraph
     checkpointer, which talks to Postgres directly rather than through
     Supabase's REST API, so it can't reuse the URL/key above. Without it,
     the graph falls back to an in-memory checkpointer: fine for a pilot
     on a single always-on instance, but call state won't survive a
     restart/redeploy and isn't shared across instances. Get it from
     Supabase → Project Settings → Database → Connection string, once
     durable state matters.
   - `CALENDLY_API_KEY` (a Personal Access Token, not OAuth) /
     `CALENDLY_EVENT_TYPE_URI` — see docs/voice-agent-plan.md for how to
     fetch the event type URI via the API. The Calendly tools degrade
     gracefully (tell the agent to take a message instead) if these are
     unset.
   - `PUBLIC_BASE_URL` — this service's public URL, for Telnyx's webhook
     callbacks and the Media Streaming WebSocket (e.g. an `https://*.fly.dev`
     URL once deployed, or an ngrok URL for local testing against a real
     call). Still blank until there's an actual deploy or tunnel.
3. Migration already run for the current Supabase project
   (`supabase/migrations/0001_voice_agent_init.sql`) — re-run it (or any
   new migration file added later) via `supabase db push` or the SQL
   editor if the project ever changes.
4. `npm run dev` for local development. Telnyx needs a publicly reachable
   URL to send webhooks and open the media stream to — use `ngrok http
   8080` (or similar) and set `PUBLIC_BASE_URL` to that during local
   testing.
5. Once deployed (see below) and `PUBLIC_BASE_URL` is real, reassign
   `+12137580964`'s **inbound** routing to the new Call Control connection
   (Telnyx portal → Numbers → My Numbers → this number → Connection). This
   is the one step that actually makes calls reach this service — do it
   last, deliberately.

## Deploy

`fly launch` once (creates the app from `fly.toml`), then `fly deploy` for
subsequent deploys. Set the same env vars as secrets: `fly secrets set
KEY=value ...`. If the assigned Fly.io URL differs from
`jetzt-voice-agent.fly.dev`, update the Telnyx connection's
`webhook_event_url` to match (see "Status" above) and set
`PUBLIC_BASE_URL` accordingly.

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
- **No durable checkpointing yet** — running on the in-memory fallback
  until `SUPABASE_DB_URL` is set (see Setup above).
