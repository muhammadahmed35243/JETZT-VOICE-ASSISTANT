// Next.js loads .env.local itself (both in `next dev` and at Vercel build
// time) — no manual dotenv wiring needed here the way the standalone
// Express version required.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  // A stable custom domain, not Vercel's per-deployment VERCEL_URL — the
  // Telnyx connection's webhook_event_url is fixed at the connection
  // level, so it needs one address that doesn't change between deploys.
  publicBaseUrl: required("PUBLIC_BASE_URL"),

  telnyx: {
    apiKey: required("TELNYX_API_KEY"),
    publicKey: required("TELNYX_PUBLIC_KEY"),
    phoneNumber: required("TELNYX_PHONE_NUMBER"),
    callControlConnectionId: required("TELNYX_CALL_CONTROL_CONNECTION_ID"),
  },

  deepgram: {
    apiKey: required("DEEPGRAM_API_KEY"),
  },

  openai: {
    apiKey: required("OPENAI_API_KEY"),
  },

  supabase: {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    // Optional — only used by the LangGraph checkpointer, which talks to
    // Postgres directly rather than through Supabase's REST API. Without
    // it, the graph falls back to an in-memory checkpointer (see
    // src/agent/graph.ts) instead of blocking on a value nothing else in
    // this service needs.
    dbUrl: optional("SUPABASE_DB_URL"),
  },

  calendly: {
    // Pending — see docs/voice-agent-plan.md "Pre-build checklist". Left
    // optional so the rest of the service can run before credentials land;
    // the Calendly tool checks these itself and tells the caller it isn't
    // available yet if they're unset.
    apiKey: optional("CALENDLY_API_KEY"),
    eventTypeUri: optional("CALENDLY_EVENT_TYPE_URI"),
  },
} as const;
