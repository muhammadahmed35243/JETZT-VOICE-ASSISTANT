import { config } from "../config";

/**
 * Dependency-free Google Calendar client (plain fetch), same approach and
 * same OAuth app as the JETZT portal's lib/google/calendar.ts — the voice
 * agent books onto the same company calendar the portal schedules team
 * meetings on, so availability accounts for both.
 *
 * That OAuth grant has the `calendar.events` scope only, which doesn't
 * cover the freeBusy endpoint — busy time is computed from events.list
 * instead.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_ID = "primary";

export class GoogleCalendarError extends Error {}

export function googleCalendarConfigured(): boolean {
  const g = config.googleCalendar;
  return Boolean(g.clientId && g.clientSecret && g.refreshToken);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const g = config.googleCalendar;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: g.clientId!,
      client_secret: g.clientSecret!,
      refresh_token: g.refreshToken!,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    // invalid_grant = the grant was revoked (e.g. "Disconnect" in the portal).
    throw new GoogleCalendarError(`Google token refresh failed: ${json.error ?? res.status}`);
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function calendarFetch<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return null;
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new GoogleCalendarError(json?.error?.message ?? `Google Calendar error (${res.status})`);
  return json;
}

interface GoogleEvent {
  id: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  hangoutLink?: string;
}

export interface BusyInterval {
  start: number;
  end: number;
}

/** Busy intervals on the calendar between two instants. Skips events
 *  marked "free" (transparent), cancelled, or declined by the owner. */
export async function listBusy(timeMin: Date, timeMax: Date): Promise<BusyInterval[]> {
  const busy: BusyInterval[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await calendarFetch<{ items?: GoogleEvent[]; nextPageToken?: string }>(
      `/calendars/${CALENDAR_ID}/events?${qs}`
    );
    for (const e of page?.items ?? []) {
      if (e.status === "cancelled" || e.transparency === "transparent") continue;
      if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
      const start = Date.parse(e.start?.dateTime ?? e.start?.date ?? "");
      const end = Date.parse(e.end?.dateTime ?? e.end?.date ?? "");
      if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end });
    }
    pageToken = page?.nextPageToken;
  } while (pageToken);
  return busy;
}

export async function createMeeting(input: {
  title: string;
  description: string;
  start: Date;
  end: Date;
  attendeeEmail: string;
  requestId: string;
}): Promise<{ eventId: string; meetLink: string | null }> {
  const qs = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: "all" });
  const event = await calendarFetch<GoogleEvent>(`/calendars/${CALENDAR_ID}/events?${qs}`, {
    method: "POST",
    body: JSON.stringify({
      summary: input.title,
      description: input.description,
      start: { dateTime: input.start.toISOString() },
      end: { dateTime: input.end.toISOString() },
      attendees: [{ email: input.attendeeEmail }],
      // Without conferenceDataVersion=1 Google creates the event but no Meet link.
      conferenceData: {
        createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    }),
  });
  if (!event) throw new GoogleCalendarError("Google returned no event");
  return { eventId: event.id, meetLink: event.hangoutLink ?? null };
}

/** Moves an event in place — attendees get Google's "updated" email and the
 *  Meet link stays the same (unlike Calendly's cancel-and-rebook). */
export async function moveMeeting(eventId: string, start: Date, end: Date): Promise<void> {
  await calendarFetch(`/calendars/${CALENDAR_ID}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: "PATCH",
    body: JSON.stringify({ start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }),
  });
}

export async function cancelMeeting(eventId: string): Promise<void> {
  try {
    await calendarFetch(`/calendars/${CALENDAR_ID}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "DELETE",
    });
  } catch (err) {
    // Already gone on Google's side is fine.
    if (err instanceof GoogleCalendarError && /not found|deleted|gone/i.test(err.message)) return;
    throw err;
  }
}
