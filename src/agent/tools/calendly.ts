import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../../config.js";
import { EMAIL_CONFIRMATION_INSTRUCTIONS, isPlausibleEmail } from "../emailConfirm.js";
import {
  eventUuidFromUri,
  findActiveBooking,
  markCancelled,
  recordBooking,
  replaceWithReschedule,
} from "../../calendly/bookings.js";

const CALENDLY_API = "https://api.calendly.com";

function calendlyConfigured(): boolean {
  return Boolean(config.calendly.apiKey && config.calendly.eventTypeUri);
}

export const getAvailableSlotsTool = tool(
  async ({ startTime, endTime }: { startTime: string; endTime: string }) => {
    if (!calendlyConfigured()) {
      return "Calendly isn't connected yet — tell the caller you'll follow up by email to schedule instead, and use the take_message tool to capture their email.";
    }

    // event_type_available_times caps the window at 7 days per call.
    const url = new URL(`${CALENDLY_API}/event_type_available_times`);
    url.searchParams.set("event_type", config.calendly.eventTypeUri!);
    url.searchParams.set("start_time", startTime);
    url.searchParams.set("end_time", endTime);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.calendly.apiKey}` },
    });

    if (!res.ok) {
      return `Couldn't fetch availability (${res.status}). Offer to take a message instead.`;
    }

    const body = (await res.json()) as {
      collection?: Array<{ start_time: string }>;
    };
    const slots = body.collection?.map((s) => s.start_time) ?? [];
    if (slots.length === 0) {
      return "No open slots in that window. Try a different date range, or offer to take a message.";
    }
    return `Available times: ${slots.join(", ")}`;
  },
  {
    name: "get_available_slots",
    description:
      "Get available Calendly meeting times in a date range (max 7 days per call). Use this before offering times to the caller.",
    schema: z.object({
      startTime: z.string().describe("ISO 8601 start of the window, must be in the future"),
      endTime: z.string().describe("ISO 8601 end of the window, max 7 days after startTime"),
    }),
  }
);

/** Books via Calendly's invitees endpoint. Shared by book_meeting and the
 *  rebook half of reschedule_meeting. Throws on failure — callers translate
 *  that into a caller-facing message themselves. */
async function bookViaCalendly(startTime: string, inviteeName: string, inviteeEmail: string) {
  const res = await fetch(`${CALENDLY_API}/invitees`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.calendly.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: config.calendly.eventTypeUri,
      start_time: startTime,
      invitee: { name: inviteeName, email: inviteeEmail },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Booking failed (${res.status}: ${text})`);
  }

  const body = (await res.json()) as {
    resource?: { event?: { location?: { join_url?: string }; uri?: string } };
  };
  const eventUri = body.resource?.event?.uri;
  if (!eventUri) throw new Error("Booking succeeded but no event uri came back");

  return {
    eventUuid: eventUuidFromUri(eventUri),
    meetingLink: body.resource?.event?.location?.join_url ?? "(check email for the link)",
  };
}

export const bookMeetingTool = tool(
  async ({
    callerPhone,
    startTime,
    inviteeName,
    inviteeEmail,
  }: {
    callerPhone: string;
    startTime: string;
    inviteeName: string;
    inviteeEmail: string;
  }) => {
    if (!calendlyConfigured()) {
      return "Calendly isn't connected yet — use the take_message tool instead so someone can follow up to schedule.";
    }
    if (!isPlausibleEmail(inviteeEmail)) {
      return "That email doesn't look valid — spell it back to the caller and confirm before calling this tool again.";
    }

    // Calendly's Scheduling API — Create Event Invitee. Books directly, no
    // redirect to Calendly's own page; requires a paid Calendly plan (see
    // docs/voice-agent-plan.md Pre-build checklist).
    let booked;
    try {
      booked = await bookViaCalendly(startTime, inviteeName, inviteeEmail);
    } catch (err) {
      return `${(err as Error).message}. Offer to take a message instead.`;
    }

    await recordBooking({
      callerPhone,
      eventUuid: booked.eventUuid,
      inviteeName,
      inviteeEmail,
      scheduledTime: startTime,
    });

    return `Booked for ${startTime}. Meeting link: ${booked.meetingLink}. Calendly has also sent a confirmation email to ${inviteeEmail} — read the link back to the caller. If they later want to change or cancel it, use cancel_meeting or reschedule_meeting.`;
  },
  {
    name: "book_meeting",
    description:
      `Book a Calendly meeting directly for the caller once they've agreed on a time and confirmed their email. ${EMAIL_CONFIRMATION_INSTRUCTIONS}`,
    schema: z.object({
      callerPhone: z.string().describe("Caller's phone number, E.164 format"),
      startTime: z.string().describe("ISO 8601 start time the caller agreed to"),
      inviteeName: z.string(),
      inviteeEmail: z.string().describe("Confirmed by spelling it back before calling this tool"),
    }),
  }
);

export const cancelMeetingTool = tool(
  async ({ callerPhone, reason }: { callerPhone: string; reason: string | null }) => {
    if (!calendlyConfigured()) {
      return "Calendly isn't connected yet — use the take_message tool instead.";
    }

    const booking = await findActiveBooking(callerPhone);
    if (!booking) {
      return "No upcoming meeting found for this caller — let them know, and ask if they'd like to book one instead.";
    }

    const res = await fetch(
      `${CALENDLY_API}/scheduled_events/${booking.event_uuid}/cancellation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.calendly.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: reason || "Cancelled by caller via phone" }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `Cancellation failed (${res.status}: ${text}). Offer to take a message instead.`;
    }

    await markCancelled(booking.id);
    return `Cancelled the meeting scheduled for ${booking.scheduled_time}. Calendly will send a cancellation email to ${booking.invitee_email}.`;
  },
  {
    name: "cancel_meeting",
    description:
      "Cancel this caller's upcoming Calendly meeting, once they confirm they want to cancel it. Looks up their meeting by phone number, so no other details are needed.",
    schema: z.object({
      callerPhone: z.string().describe("Caller's phone number, E.164 format"),
      // OpenAI's structured tool-calling requires every field to be present
      // (nullable, not optional) rather than omittable — see the schema
      // warning this surfaced when first run.
      reason: z.string().nullable().describe("Reason given for cancelling, or null if none was given"),
    }),
  }
);

export const rescheduleMeetingTool = tool(
  async ({ callerPhone, newStartTime }: { callerPhone: string; newStartTime: string }) => {
    if (!calendlyConfigured()) {
      return "Calendly isn't connected yet — use the take_message tool instead.";
    }

    const booking = await findActiveBooking(callerPhone);
    if (!booking || !booking.invitee_name || !booking.invitee_email) {
      return "No upcoming meeting found for this caller to reschedule — offer to book a new one instead (book_meeting).";
    }

    // Calendly has no direct "move this event" endpoint — a reschedule is
    // a cancellation of the old event plus a fresh booking at the new time
    // (see docs/voice-agent-plan.md; confirmed against Calendly's API docs
    // while building this — there's genuinely no other way to do it
    // server-side).
    const cancelRes = await fetch(
      `${CALENDLY_API}/scheduled_events/${booking.event_uuid}/cancellation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.calendly.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Rescheduled by caller via phone" }),
      }
    );
    if (!cancelRes.ok) {
      const text = await cancelRes.text().catch(() => "");
      return `Couldn't move the meeting — cancelling the old time failed (${cancelRes.status}: ${text}). Offer to take a message instead.`;
    }

    let rebooked;
    try {
      rebooked = await bookViaCalendly(newStartTime, booking.invitee_name, booking.invitee_email);
    } catch (err) {
      return `The old time was cancelled, but booking the new one failed: ${(err as Error).message}. Use take_message so someone can follow up and finish rescheduling.`;
    }

    await replaceWithReschedule(booking.id, rebooked.eventUuid, newStartTime);
    return `Rescheduled to ${newStartTime}. Meeting link: ${rebooked.meetingLink}. Calendly has sent a new confirmation email to ${booking.invitee_email} — read the link back to the caller.`;
  },
  {
    name: "reschedule_meeting",
    description:
      "Move this caller's upcoming Calendly meeting to a new time, once they've agreed on the new time. Use get_available_slots first to offer real options. Looks up their existing meeting by phone number.",
    schema: z.object({
      callerPhone: z.string().describe("Caller's phone number, E.164 format"),
      newStartTime: z.string().describe("ISO 8601 new start time the caller agreed to"),
    }),
  }
);
