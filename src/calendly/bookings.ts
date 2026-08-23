import { supabase } from "../supabase/client.js";

export interface CalendlyBooking {
  id: string;
  caller_phone: string;
  event_uuid: string;
  invitee_name: string | null;
  invitee_email: string | null;
  scheduled_time: string | null;
  status: "booked" | "cancelled";
}

/** Pulls the trailing uuid off a Calendly resource URI like
 *  https://api.calendly.com/scheduled_events/{uuid}. */
export function eventUuidFromUri(uri: string): string {
  return uri.split("/").filter(Boolean).pop() ?? uri;
}

export async function recordBooking(params: {
  callerPhone: string;
  eventUuid: string;
  inviteeName: string;
  inviteeEmail: string;
  scheduledTime: string;
}): Promise<void> {
  const { error } = await supabase.from("calendly_bookings").insert({
    caller_phone: params.callerPhone,
    event_uuid: params.eventUuid,
    invitee_name: params.inviteeName,
    invitee_email: params.inviteeEmail,
    scheduled_time: params.scheduledTime,
    status: "booked",
  });
  if (error) console.error("recordBooking failed:", error.message);
}

/**
 * Most recent active booking for this caller. v1 limitation: assumes one
 * active booking per caller — a caller with multiple simultaneous meetings
 * will only get the latest one found here.
 */
export async function findActiveBooking(
  callerPhone: string
): Promise<CalendlyBooking | null> {
  const { data, error } = await supabase
    .from("calendly_bookings")
    .select("*")
    .eq("caller_phone", callerPhone)
    .eq("status", "booked")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("findActiveBooking failed:", error.message);
    return null;
  }
  return data;
}

export async function markCancelled(bookingId: string): Promise<void> {
  const { error } = await supabase
    .from("calendly_bookings")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", bookingId);
  if (error) console.error("markCancelled failed:", error.message);
}

export async function replaceWithReschedule(
  bookingId: string,
  newEventUuid: string,
  newScheduledTime: string
): Promise<void> {
  const { error } = await supabase
    .from("calendly_bookings")
    .update({
      event_uuid: newEventUuid,
      scheduled_time: newScheduledTime,
      status: "booked",
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId);
  if (error) console.error("replaceWithReschedule failed:", error.message);
}
