import { randomUUID } from "crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../../config";
import { isSimulatedRun } from "../../calls/simulation";
import { EMAIL_CONFIRMATION_INSTRUCTIONS, isPlausibleEmail } from "../emailConfirm";
import { findOpenSlots, isSlotOpen, slotEnd } from "../../google/availability";
import { cancelMeeting, createMeeting, googleCalendarConfigured, moveMeeting } from "../../google/calendar";
import { findActiveBooking, markCancelled, markRescheduled, recordBooking } from "../../bookings/bookings";

// Every result that isn't a success starts with "NOT DONE" and says what to
// tell the caller. On a test call the model got the old soft wording ("online
// booking isn't set up yet...") back from cancel_meeting and still told the
// caller their meeting was cancelled.
function notConfigured(action: string): string {
  return `NOT DONE — ${action} isn't available because online scheduling isn't set up yet. Nothing was changed. Don't tell the caller it worked: say the team will take care of it, and use take_message to pass it on.`;
}
const MAX_DAYS_OFFERED = 3;
const MAX_SLOTS_PER_DAY = 4;

function validTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return config.booking.timeZone;
  }
}

/** "Thursday, October 9 at 2:30 PM" in the caller's timezone. */
function spoken(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} at ${time}`;
}

export const getAvailableSlotsTool = tool(
  async ({ fromDate, timeZone }: { fromDate: string | null; timeZone: string }) => {
    if (!googleCalendarConfigured()) return notConfigured("Checking open times");
    timeZone = validTimeZone(timeZone);
    const from = fromDate ? new Date(`${fromDate}T00:00:00Z`) : new Date();

    let slots;
    try {
      slots = await findOpenSlots(Number.isNaN(from.getTime()) ? new Date() : from, 7);
    } catch (err) {
      console.error("[calendar] availability failed:", err);
      return "NOT DONE — couldn't check the calendar right now. Offer to take a message so the team can schedule.";
    }
    if (slots.length === 0) {
      return "No open times in the next week from that date. Offer a later week, or take a message.";
    }

    // Grouped by day in the caller's timezone and trimmed — reading out a
    // week of half-hour slots isn't an option on a call. Each time carries
    // the exact ISO value to book with.
    const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    const byDay = new Map<string, string[]>();
    for (const s of slots) {
      const key = day.format(s.start);
      if (!byDay.has(key) && byDay.size >= MAX_DAYS_OFFERED) break;
      const list = byDay.get(key) ?? [];
      if (list.length < MAX_SLOTS_PER_DAY) list.push(`${time.format(s.start)} [${s.start.toISOString()}]`);
      byDay.set(key, list);
    }
    return [
      `Open ${config.booking.slotMinutes}-minute times, shown in ${timeZone}:`,
      ...[...byDay].map(([d, times]) => `${d}: ${times.join(", ")}`),
      'Offer two or three of these in plain speech ("Thursday at two or two thirty?"). The bracketed value is the exact startTime for book_meeting — never read it aloud. If the caller wants a different day, call this again with fromDate.',
    ].join("\n");
  },
  {
    name: "get_available_slots",
    description: "Find open meeting times with the JETZT team. Use this before offering times to the caller.",
    schema: z.object({
      fromDate: z.string().nullable().describe("YYYY-MM-DD to start looking from, or null for today"),
      timeZone: z
        .string()
        .describe(
          "Caller's IANA timezone, e.g. America/New_York. Infer it from their area code and confirm it, or ask."
        ),
    }),
  }
);

export const bookMeetingTool = tool(
  async (
    {
      callerPhone,
      startTime,
      timeZone,
      inviteeName,
      inviteeEmail,
      notes,
    }: {
      callerPhone: string;
      startTime: string;
      timeZone: string;
      inviteeName: string;
      inviteeEmail: string;
      notes: string | null;
    },
    runConfig
  ) => {
    if (!googleCalendarConfigured()) return notConfigured("Booking");
    if (!isPlausibleEmail(inviteeEmail)) {
      return "NOT DONE — that email doesn't look valid. Spell it back to the caller and confirm before calling this tool again.";
    }
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return "NOT DONE — that startTime isn't valid. Use the exact bracketed value from get_available_slots.";
    }
    timeZone = validTimeZone(timeZone);
    if (isSimulatedRun(runConfig)) {
      return `Booked for ${spoken(start, timeZone)}. A calendar invite with the Google Meet link is on its way to ${inviteeEmail}.`;
    }

    try {
      if (!(await isSlotOpen(start))) {
        return "NOT DONE — that time was just taken or isn't available. Apologize briefly, call get_available_slots again, and offer new times.";
      }
      const meeting = await createMeeting({
        title: `JETZT call with ${inviteeName}`,
        description: [`Booked by the JETZT phone assistant.`, `Caller: ${inviteeName}, ${callerPhone}`, notes ? `Notes: ${notes}` : ""]
          .filter(Boolean)
          .join("\n"),
        start,
        end: slotEnd(start),
        attendeeEmail: inviteeEmail,
        requestId: randomUUID(),
      });
      await recordBooking({
        callerPhone,
        eventUuid: meeting.eventId,
        inviteeName,
        inviteeEmail,
        scheduledTime: start.toISOString(),
      });
    } catch (err) {
      console.error("[calendar] booking failed:", err);
      return "NOT DONE — booking failed on our side. Apologize, and use take_message so the team can schedule it.";
    }
    return `Booked for ${spoken(start, timeZone)}. A calendar invite with the Google Meet link is on its way to ${inviteeEmail}. Tell the caller that — don't read out any link.`;
  },
  {
    name: "book_meeting",
    description: `Book a meeting with the JETZT team once the caller has picked a time and confirmed their email. ${EMAIL_CONFIRMATION_INSTRUCTIONS}`,
    schema: z.object({
      callerPhone: z.string().describe("Caller's phone number, E.164 format"),
      startTime: z.string().describe("Exact bracketed ISO time from get_available_slots"),
      timeZone: z.string().describe("Caller's IANA timezone, used to confirm the time back to them"),
      inviteeName: z.string(),
      inviteeEmail: z.string().describe("Confirmed by spelling it back before calling this tool"),
      notes: z.string().nullable().describe("What they want to discuss, in a sentence, or null"),
    }),
  }
);

export const cancelMeetingTool = tool(
  async ({ callerPhone }: { callerPhone: string }, runConfig) => {
    if (!googleCalendarConfigured()) return notConfigured("Cancelling");
    const booking = isSimulatedRun(runConfig) ? null : await findActiveBooking(callerPhone);
    if (!booking) {
      return "NOT DONE — no upcoming meeting found for this caller. Nothing was cancelled. Let them know, and ask if they'd like to book one instead.";
    }
    try {
      await cancelMeeting(booking.event_uuid);
    } catch (err) {
      console.error("[calendar] cancel failed:", err);
      return "NOT DONE — cancelling failed on our side. Apologize, and use take_message so the team can cancel it.";
    }
    await markCancelled(booking.id);
    return `Cancelled the meeting that was set for ${booking.scheduled_time}. Google Calendar has emailed ${booking.invitee_email} the cancellation.`;
  },
  {
    name: "cancel_meeting",
    description:
      "Cancel this caller's upcoming meeting, once they confirm they want to. Finds it by phone number, so no other details are needed.",
    schema: z.object({
      callerPhone: z.string().describe("Caller's phone number, E.164 format"),
    }),
  }
);

export const rescheduleMeetingTool = tool(
  async (
    { callerPhone, newStartTime, timeZone }: { callerPhone: string; newStartTime: string; timeZone: string },
    runConfig
  ) => {
    if (!googleCalendarConfigured()) return notConfigured("Rescheduling");
    const booking = isSimulatedRun(runConfig) ? null : await findActiveBooking(callerPhone);
    if (!booking) {
      return "NOT DONE — no upcoming meeting found for this caller to move. Offer to book a new one instead (book_meeting).";
    }
    const start = new Date(newStartTime);
    if (Number.isNaN(start.getTime())) {
      return "NOT DONE — that newStartTime isn't valid. Use the exact bracketed value from get_available_slots.";
    }
    try {
      if (!(await isSlotOpen(start))) {
        return "NOT DONE — that time isn't available. Call get_available_slots again and offer new times.";
      }
      await moveMeeting(booking.event_uuid, start, slotEnd(start));
    } catch (err) {
      console.error("[calendar] reschedule failed:", err);
      return "NOT DONE — moving the meeting failed on our side. Apologize, and use take_message so the team can reschedule.";
    }
    await markRescheduled(booking.id, start.toISOString());
    return `Moved to ${spoken(start, validTimeZone(timeZone))}. Same Meet link; Google Calendar has emailed ${booking.invitee_email} the update.`;
  },
  {
    name: "reschedule_meeting",
    description:
      "Move this caller's upcoming meeting to a new time they've agreed to. Use get_available_slots first to offer real options. Finds the meeting by phone number.",
    schema: z.object({
      callerPhone: z.string().describe("Caller's phone number, E.164 format"),
      newStartTime: z.string().describe("Exact bracketed ISO time from get_available_slots"),
      timeZone: z.string().describe("Caller's IANA timezone, used to confirm the time back to them"),
    }),
  }
);
