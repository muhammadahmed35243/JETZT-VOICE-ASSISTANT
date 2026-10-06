import { config } from "../config";
import { listBusy } from "./calendar";

/**
 * Bookable slots = business hours (BOOKING_* env, in the business's own
 * timezone) minus anything already on the calendar. Calendly used to own
 * these rules; with Google Calendar they live here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Offset (ms) of `timeZone` from UTC at a given instant. */
function tzOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** UTC instant for a wall-clock time in `timeZone` (DST-safe: the offset is
 *  re-checked at the resulting instant). */
function zonedToUtc(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, 0, minutes);
  const first = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(first, timeZone);
}

function localDate(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: Number(get("year")), m: Number(get("month")) - 1, d: Number(get("day")), weekday };
}

export interface Slot {
  start: Date;
  end: Date;
}

export async function findOpenSlots(from: Date, days: number): Promise<Slot[]> {
  const b = config.booking;
  const slotMs = b.slotMinutes * 60 * 1000;
  const earliest = Math.max(from.getTime(), Date.now() + b.minNoticeMinutes * 60 * 1000);
  const windowEnd = earliest + days * DAY_MS;
  const busy = await listBusy(new Date(earliest), new Date(windowEnd + DAY_MS));

  const slots: Slot[] = [];
  // Walk calendar days in the business timezone.
  for (let t = earliest - DAY_MS; t < windowEnd + DAY_MS; t += DAY_MS) {
    const { y, m, d, weekday } = localDate(t, b.timeZone);
    if (!b.days.includes(weekday)) continue;
    const dayStart = zonedToUtc(y, m, d, b.startMinutes, b.timeZone);
    const dayEnd = zonedToUtc(y, m, d, b.endMinutes, b.timeZone);
    for (let s = dayStart; s + slotMs <= dayEnd; s += slotMs) {
      if (s < earliest || s >= windowEnd) continue;
      const e = s + slotMs;
      if (busy.some((x) => x.start < e && x.end > s)) continue;
      if (slots.some((x) => x.start.getTime() === s)) continue; // DST / overlapping walk
      slots.push({ start: new Date(s), end: new Date(e) });
    }
  }
  return slots.sort((a, z) => a.start.getTime() - z.start.getTime());
}

/** Whether [start, start+slot) is still inside business hours and free —
 *  checked again right before booking, since time passes during a call. */
export async function isSlotOpen(start: Date): Promise<boolean> {
  const slots = await findOpenSlots(new Date(start.getTime() - 60 * 1000), 1);
  return slots.some((s) => s.start.getTime() === start.getTime());
}

export function slotEnd(start: Date): Date {
  return new Date(start.getTime() + config.booking.slotMinutes * 60 * 1000);
}
