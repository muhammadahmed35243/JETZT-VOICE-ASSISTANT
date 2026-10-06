import { supabase } from "../supabase/client";

// Meetings booked by phone, so a later call can find "their" meeting to
// cancel or move without the caller knowing any ids. The table is still
// named calendly_bookings from before the switch to Google Calendar —
// event_uuid now holds the Google Calendar event id. v1 assumes one
// active booking per caller phone number.
const TABLE = "calendly_bookings";

export interface Booking {
  id: string;
  caller_phone: string;
  event_uuid: string;
  invitee_name: string | null;
  invitee_email: string | null;
  scheduled_time: string | null;
  status: "booked" | "cancelled";
}

export async function recordBooking(params: {
  callerPhone: string;
  eventUuid: string;
  inviteeName: string;
  inviteeEmail: string;
  scheduledTime: string;
}): Promise<void> {
  const { error } = await supabase.from(TABLE).insert({
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
): Promise<Booking | null> {
  const { data, error } = await supabase
    .from(TABLE)
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
    .from(TABLE)
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", bookingId);
  if (error) console.error("markCancelled failed:", error.message);
}

export async function markRescheduled(bookingId: string, newScheduledTime: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({
      scheduled_time: newScheduledTime,
      status: "booked",
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId);
  if (error) console.error("markRescheduled failed:", error.message);
}
