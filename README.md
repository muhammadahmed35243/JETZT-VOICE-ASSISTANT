# JETZT Voice Agent — backend

![JETZT AI Voice Assistant](public/image.png)

Inbound AI voice agent for JETZT. Answers calls to the existing number
(`+1 (213) 758-0964`, shared with the outbound cold dialer — see
`docs/what-already-done-in-dialer.md`), runs Telnyx Call Control + Media
Streaming into Deepgram STT → LangGraph (GPT-4o + tools) → Deepgram TTS.
Full design in `docs/voice-agent-plan.md`.

**Repo relationship to the dialer:** two separate repos, two separate
Vercel deployments — this one deploys standalone. They're linked only by
sharing one Supabase database (the dialer's project), not by sharing code.
The admin portal is still new pages inside the *dialer's* app, not here.

## Status

**Deployed and live** at `https://customized-jetzt-voice-agentvercela.vercel.app`.
Confirmed against the real deployment, not assumed:
- `GET /api/health` → `200 {"ok":true}`
- `POST /api/telnyx/webhook` with a bad signature → `403`, not a `500` —
  proves `config.ts` loads cleanly with the env vars actually set in
  Vercel, and signature verification is doing its job.
- **A real WebSocket handshake against `/api/media-stream` succeeds** —
  tested with an actual `ws` client, not curl (a plain `GET` there 500s,
  which is expected for a WebSocket-only endpoint hit without real
  upgrade headers, not a bug). This was the single biggest unknown in the
  whole Vercel port — `experimental_upgradeWebSocket` genuinely works in
  production, and Fluid Compute is correctly enabled.

The Telnyx Call Control connection's `webhook_event_url` now points at
this real domain (updated via the API). Not yet done: a real phone call
end-to-end, and the number's inbound routing still hasn't been reassigned
(deliberately — see below).

Also fixed along the way, both confirmed against the installed packages
rather than guessed:
- `@vercel/functions` needed to be `^3.9.5`, not the `^1.6.0` first
  guessed — that version doesn't export `experimental_upgradeWebSocket` at
  all. Its type definitions also confirm the handler receives a genuine
  `ws` package `WebSocket`, which resolved the "what shape is this socket"
  uncertainty flagged earlier — `src/telnyx/mediaStream.ts` uses the real
  `ws` types now, `readyState`/`OPEN` included, no defensive stand-in.
- Every relative/`@/`-aliased import across `app/` and `src/` had a `.js`
  suffix (correct for the old NodeNext/tsc setup, wrong for Next.js's
  webpack bundler resolution — `tsc --noEmit` didn't catch this, only an
  actual `next build` did). Stripped from all 20 files.

Done as part of setup already:
- A new Telnyx Call Control connection exists (id `3033141056032998992`,
  name "JETZT Voice Agent"), created via the API — separate from the
  dialer's `Cold Dialer` TeXML connection. Its `webhook_event_url` now
  points at the real deployment:
  `https://customized-jetzt-voice-agentvercela.vercel.app/api/telnyx/webhook`.
- `+12137580964`'s **inbound routing has deliberately not been
  reassigned** to this new connection yet — do that only once this service
  is actually deployed and reachable, or incoming calls will go
  unanswered. The dialer's outbound calls are unaffected either way (see
  docs/voice-agent-plan.md "Reusing the existing number").
- Calendly is configured with a Personal Access Token (the right choice
  for a single internal account) and a confirmed event type ("30 Minute
  Meeting").
- `src/agent/tools/businessData.ts` now reads/writes the dialer's *real*
  `leads` table (`phone`, not the `phone_number` column an earlier version
  guessed — fixed after actually reading `D:\Dialer\supabase\schema.sql`).

## Why Vercel, and the real tradeoffs that come with it

Originally built for Fly.io (an always-on process, no caveats needed for a
live per-call WebSocket). Moved to Vercel because it's the same platform
the dialer already runs on. This uses `experimental_upgradeWebSocket()`
from `@vercel/functions` — genuinely experimental, Vercel's own naming,
shipped as a public beta June 2026. Worth knowing before this fields real
calls:
- **No confirmed reconnection resilience.** Vercel's own docs say a
  dropped connection reconnecting may land on a fresh instance that
  "knows nothing about the previous one." For a phone call, a dropped
  connection is just a dead call — there's no graceful mid-call recovery.
- **Duration cap.** `maxDuration` is `300` (in `vercel.json` and on the
  route itself) — the actual ceiling on the current plan; deploying with
  `800` was rejected outright ("must be between 1 and 300 seconds...
  upgrade your plan"), so the longer duration needs more than a Pro
  subscription to unlock. 300s covers the ~3-minute average call with
  headroom, but anything past 5 minutes would get cut off. Separately,
  Fluid Compute (required for WebSocket support at all) has to be turned
  on in the Vercel project's settings — a dashboard step, not something a
  config file can do.
- **The exact socket API surface Vercel hands us wasn't fully
  confirmable without a live `vercel dev` run** — see the comment on
  `MediaSocket` in `src/telnyx/mediaStream.ts`.

None of this is a reason not to proceed — it's what to check first if
calls behave strangely once this is live.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in:
   - Telnyx: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_PHONE_NUMBER`,
     `TELNYX_CALL_CONTROL_CONNECTION_ID` (see "Status" above)
   - `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — **now the dialer's own
     Supabase project** (`bxtmcelkwglvidkcmgkp`), not a separate one, per
     the "two repos, shared database" decision. Every Supabase call here
     goes through the REST API via `supabase-js`, so these two are all
     that's needed for that.
   - `SUPABASE_DB_URL` — **optional**, only for the LangGraph checkpointer
     (talks to Postgres directly, not through Supabase's REST API — can't
     reuse the URL/key above). Without it, conversation state falls back
     to an in-memory checkpointer: fine for a pilot, but state is lost on
     every redeploy and isn't shared across instances — worth knowing
     given Vercel's instance model is more ephemeral than a single
     long-running Fly.io process was.
   - `CALENDLY_API_KEY` (a Personal Access Token, not OAuth) /
     `CALENDLY_EVENT_TYPE_URI`
   - `PUBLIC_BASE_URL` — a **stable custom domain**, not Vercel's
     per-deployment URL — Telnyx's webhook URL is fixed on the connection,
     so it needs one address that doesn't change between deploys.
3. **Run the migration against the dialer's Supabase project**
   (`supabase/migrations/0001_voice_agent_init.sql`, project
   `bxtmcelkwglvidkcmgkp`) — paste it into that project's SQL editor. Not
   yet run there (it was run against a different, now-abandoned project
   before the "shared database" decision).
4. `npm run dev` (`next dev`) for local development — but note
   `experimental_upgradeWebSocket` specifically requires `vercel dev`, not
   plain `next dev`, to actually work; use `vercel dev` when testing the
   media-stream route. Telnyx also needs a publicly reachable URL, so pair
   either with `ngrok http 3000`.
5. In the Vercel project settings: **enable Fluid Compute** (required for
   WebSocket support). Not optional — the route won't work without it.
6. Once deployed and `PUBLIC_BASE_URL` is real: update the Telnyx
   connection's `webhook_event_url` (see "Status"), then reassign
   `+12137580964`'s **inbound** routing to it last, deliberately.

## Deploy

`vercel` (or connect the repo in the Vercel dashboard) for the first
deploy, `vercel --prod` for production. Set env vars in the Vercel
project's Environment Variables settings (same keys as `.env.local`).
Remember Fluid Compute has to be enabled once, manually, in project
settings — no CLI flag for it.

## Known follow-ups

- **Verify against a real call, end to end** — the Media Streaming wire
  format *and* the Vercel WebSocket API are both unconfirmed without live
  traffic. This is the single most important next step.
- **Recording storage** currently saves Telnyx's own recording URL
  directly (`call.recording.saved` handler in
  `app/api/telnyx/webhook/route.ts`). The plan calls for mirroring the
  dialer's `lib/storage.ts` pattern (download + re-upload to Supabase
  Storage) instead. Since this repo can now see the dialer's actual code,
  this is portable now — not yet done.
- **`leads.phone` normalization** — not verified how the dialer stores
  phone numbers (with/without `+1`, dashes, etc.). If lookups come back
  empty for callers who should exist, check this first.
- **LangGraph turn timing is sentence-level, not token-level** — each turn
  runs to completion (including any tool calls) before TTS starts, then
  streams sentence-by-sentence. See the comment in
  `src/telnyx/mediaStream.ts`.
- **Barge-in is not implemented** — matches the plan's decision to ship v1
  without it.
- **No durable checkpointing yet** — running on the in-memory fallback
  until `SUPABASE_DB_URL` is set, which matters more on Vercel's
  instance model than it did on a single Fly.io process.
