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

/** "09:00-17:00" -> minutes after midnight. */
function parseHours(value: string): { startMinutes: number; endMinutes: number } {
  const m = value.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`BOOKING_HOURS must look like 09:00-17:00, got ${value}`);
  return { startMinutes: +m[1] * 60 + +m[2], endMinutes: +m[3] * 60 + +m[4] };
}

/** "1-5" or "1,3,5" -> weekday numbers, 0 = Sunday. */
function parseDays(value: string): number[] {
  const range = value.match(/^(\d)\s*-\s*(\d)$/);
  if (range) {
    const days = [];
    for (let d = +range[1]; d <= +range[2]; d++) days.push(d);
    return days;
  }
  return value.split(",").map((d) => Number(d.trim()));
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

  // Same Google OAuth app + company calendar as the JETZT portal (its
  // GOOGLE_CALENDAR_CLIENT_ID/SECRET, and a refresh token for the
  // connected account). Optional: until set, the booking tools tell the
  // caller the team will follow up and take a message instead.
  googleCalendar: {
    clientId: optional("GOOGLE_CALENDAR_CLIENT_ID"),
    clientSecret: optional("GOOGLE_CALENDAR_CLIENT_SECRET"),
    refreshToken: optional("GOOGLE_CALENDAR_REFRESH_TOKEN"),
  },

  // When callers can book, in the business's own timezone.
  booking: {
    timeZone: optional("BOOKING_TIMEZONE") ?? "America/Los_Angeles",
    ...parseHours(optional("BOOKING_HOURS") ?? "09:00-17:00"),
    days: parseDays(optional("BOOKING_DAYS") ?? "1-5"),
    slotMinutes: Number(optional("BOOKING_SLOT_MINUTES") ?? 30),
    minNoticeMinutes: Number(optional("BOOKING_MIN_NOTICE_MINUTES") ?? 120),
  },
} as const;
