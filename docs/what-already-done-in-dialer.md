# Outbound Calling — Telnyx Configuration & How the Dialer Uses It

This document explains, end to end, how the phone number this app dials out
from is configured on Telnyx's side, and exactly how the dialer app uses
that configuration to place a call. All Telnyx-side details below were
pulled live from the Telnyx API while writing this doc, not from memory or
assumption.

## 1. The phone number

| | |
|---|---|
| Number | `+1 (213) 758-0964` |
| Status | `active` |
| Type | Local (US) |
| Purchased | 2026-08-19 |
| Assigned connection | `Cold Dialer` (`3030232793461294148`) |

`.env.local` / Vercel env: `TELNYX_PHONE_NUMBER=+12137580964`

A number's "assigned connection" in Telnyx controls **inbound** routing only
(where a call *to* this number gets delivered). It has no bearing on
outbound calls — those are routed by whichever connection ID the app
explicitly passes when it asks Telnyx to place a call (see §3). Right now
this number isn't configured to receive inbound calls in any special way;
it's used purely as the outbound caller ID / origination number.

## 2. The connection: "Cold Dialer"

| Field | Value |
|---|---|
| ID | `3030232793461294148` |
| Type | `call_control_xml_connection` (a **TeXML** connection — Telnyx's Twilio-TwiML-compatible calling API) |
| Active | `true` |
| Outbound Voice Profile | `Cold Dialer Outbound` (`3030234569128281326`) |
| Anchorsite | Ashburn, VA (the Telnyx media/signaling region this connection anchors to) |
| Webhook API version | 2 |
| Connection-level webhook URL | *(none set)* — every webhook URL is instead passed per-call by the app itself (see §3), so nothing needs to be configured on the connection for this |

`.env.local` / Vercel env: `TELNYX_TEXML_CONNECTION_ID=3030232793461294148`

TeXML is Telnyx's TwiML-compatible calling API: same `To`/`From`/`Url`
form-encoded request shape and the same XML response format (`<Dial>`,
`<Say>`, etc.) that Twilio's Voice API uses. That compatibility is why this
app's TeXML builder (`lib/telnyx.ts`) looks like a Twilio integration even
though it's calling Telnyx.

**A second connection also exists on the account** — `JETZT Dialer WebRTC`
(`3030936660805158607`, a `credential_connection`) — used only for
browser-based (WebRTC) calling, not phone-bridge calling. It shares the same
Outbound Voice Profile as "Cold Dialer" (see §3), which is why the daily
spend limit below is shared across both calling modes, not per-mode.

## 3. The Outbound Voice Profile: "Cold Dialer Outbound"

An Outbound Voice Profile is Telnyx's container for outbound-calling policy
— spend limits, allowed destination countries, recording defaults — applied
to every connection assigned to it.

| Field | Value |
|---|---|
| ID | `3030234569128281326` |
| Traffic type | `conversational` |
| Service plan | `global` |
| Connections using this profile | 2 — `Cold Dialer` (TeXML) and `JETZT Dialer WebRTC` (Credential) |
| Daily spend limit | **$10.00/day**, enabled (raised from the original $5.00 default) |
| Concurrent call limit | none set |
| Call recording (profile-level) | `none` — **this is expected and does not disable recording.** The profile's own auto-recording feature is off; recording is instead driven explicitly by the app itself — `record="record-from-answer-dual"` on the TeXML `<Dial>` for phone-bridge calls, and the Call Control `record_start` action for WebRTC calls. See `docs/` recording notes / `lib/storage.ts`. |
| Whitelisted destinations | A broad allow-list covering North America, most of the EU/EEA, and a Middle-East/Central-Asia block that includes **Pakistan (`PK`)** — this is what makes calls to Pakistani numbers possible at all; a destination not in this list is rejected before it ever reaches the carrier. |

**Both spend limit and destination whitelist apply account-wide across this
profile** — if you ever see outbound calls failing account-wide with a
spend-limit-style error, check this profile first before assuming an app
bug.

## 4. How the dialer app actually uses all of this (phone-bridge flow)

This is the call path for **Phone mode** (the default — the agent's own
phone rings first, then gets bridged to the lead). Browser/WebRTC mode is a
separate flow documented in `README.md` under "Calling Flow" and isn't
covered here since it doesn't originate from this number/connection the
same way.

```
Agent clicks "Call"
        │
        ▼
POST /api/calls  (app/api/calls/route.ts)
  - creates a `calls` row (status=initiating)
  - marks the lead in_progress
  - calls lib/telnyx.ts → initiateCall(agentPhone, callRecordId)
        │
        ▼
POST https://api.telnyx.com/v2/texml/calls/{TELNYX_TEXML_CONNECTION_ID}
  To:               agent's own phone number
  From:             TELNYX_PHONE_NUMBER  (+12137580964)
  Url:              /api/calls/connect?callRecordId=...
  StatusCallback:   /api/calls/status
        │
        ▼
Telnyx rings the AGENT's phone first
        │
        ▼ (agent answers)
Telnyx fetches Url → POST /api/calls/connect
  - verifies the Ed25519 webhook signature (§5)
  - marks agent_call_status = "completed" (agent answered)
  - looks up the lead's phone number from the call record
  - responds with TeXML:
      <Say>compliance/recording-consent notice</Say>
      <Dial callerId="+12137580964"
            record="record-from-answer-dual"
            recordingStatusCallback="/api/calls/recording"
            action="/api/calls/dial-status?callRecordId=...">
        <Number>{lead's phone}</Number>
      </Dial>
        │
        ▼
Telnyx dials the LEAD, using +12137580964 as caller ID, recording the leg
        │
        ├─▶ POST /api/calls/status         (outer call's own lifecycle —
        │      only used as a fallback if the agent never answers at all)
        │
        ├─▶ POST /api/calls/recording      (once the recording file is
        │      ready — downloaded and re-uploaded to Supabase Storage,
        │      see lib/storage.ts)
        │
        └─▶ POST /api/calls/dial-status    (fires when the <Dial> to the
               lead concludes — this is the AUTHORITATIVE source for what
               actually happened to the lead's leg: completed / no_answer /
               failed. Responds with <Hangup/>.)
```

Two webhook endpoints exist specifically because a phone-bridge call has
**two legs**, and each one's status means something different:

- `/api/calls/status` — the *outer* call (Telnyx ↔ agent's phone). Only
  meaningfully updates `agent_call_status`, and only for terminal events
  *before* the agent has answered — once the agent has answered, later
  events on this same webhook describe how the whole session wound down,
  not whether the agent picked up, so they're not allowed to overwrite an
  already-confirmed answer.
- `/api/calls/dial-status` — the *inner* `<Dial>` leg (Telnyx ↔ lead). This
  is the only reliable source for `lead_call_status` (connected /
  no-answer / failed) — an earlier version of this app mistakenly derived
  the lead's outcome from the outer call's status instead, which is what
  this second, dedicated webhook was added to fix.

## 5. Security: webhook signature verification

Every webhook above (`connect`, `status`, `dial-status`, `recording`) is
independently verified before any of its content is trusted:

- Telnyx signs webhooks with **Ed25519** (not HMAC, unlike Twilio) — the
  signature and timestamp arrive as the `telnyx-signature-ed25519` and
  `telnyx-timestamp` headers.
- `verifyTelnyxSignature()` in `lib/telnyx.ts` verifies
  `{timestamp}|{raw request body}` against `TELNYX_PUBLIC_KEY` (found in the
  Telnyx portal under Account Settings → Public Key — this is one key for
  the whole account, shared across every connection, not per-connection).
- The raw body is read and verified **before** it's parsed into form fields
  — Telnyx signs the exact bytes it sent, not a re-serialized version.
- Any request that fails verification is rejected with `403` before any
  database write happens.

## 6. Where each setting actually lives (quick reference)

| Setting | Where to change it |
|---|---|
| The outbound caller-ID number | `TELNYX_PHONE_NUMBER` env var, and the number's own record in Telnyx (Numbers → My Numbers) |
| Which connection outbound calls use | `TELNYX_TEXML_CONNECTION_ID` env var — this is passed explicitly per-request, independent of the number's own inbound connection assignment |
| Daily spend limit | Telnyx portal → Voice → Outbound Voice Profiles → "Cold Dialer Outbound" → Daily Spend Limit |
| Which countries can be dialed | Same profile → Whitelisted Destinations |
| Webhook signature secret | `TELNYX_PUBLIC_KEY` env var (account-wide, from Account Settings → Public Key) |
| The actual per-call webhook URLs (`connect`/`status`/`dial-status`/`recording`) | Not set in the Telnyx portal at all — passed directly in each API request from `lib/telnyx.ts`, built off `NEXT_PUBLIC_APP_URL` |
