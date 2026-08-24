import { supabase } from "../supabase/client";

type TranscriptTurn = { role: "caller" | "agent"; text: string; at: string };

export async function createCallLog(callControlId: string, callerPhone: string) {
  const { error } = await supabase.from("voice_agent_calls").insert({
    call_control_id: callControlId,
    caller_phone: callerPhone,
    started_at: new Date().toISOString(),
    transcript: [],
  });
  if (error) console.error("createCallLog failed:", error.message);
}

export async function appendTranscriptTurn(
  callControlId: string,
  role: "caller" | "agent",
  text: string
) {
  const { data, error: fetchError } = await supabase
    .from("voice_agent_calls")
    .select("transcript")
    .eq("call_control_id", callControlId)
    .maybeSingle();

  if (fetchError) {
    console.error("appendTranscriptTurn fetch failed:", fetchError.message);
    return;
  }

  const transcript: TranscriptTurn[] = data?.transcript ?? [];
  transcript.push({ role, text, at: new Date().toISOString() });

  const { error } = await supabase
    .from("voice_agent_calls")
    .update({ transcript })
    .eq("call_control_id", callControlId);

  if (error) console.error("appendTranscriptTurn update failed:", error.message);
}

export async function getTranscriptText(callControlId: string): Promise<string> {
  const { data, error } = await supabase
    .from("voice_agent_calls")
    .select("transcript")
    .eq("call_control_id", callControlId)
    .maybeSingle();

  if (error || !data?.transcript) return "";
  return (data.transcript as TranscriptTurn[])
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");
}

export async function finalizeCallLog(callControlId: string, outcome?: string) {
  const { error } = await supabase
    .from("voice_agent_calls")
    .update({ ended_at: new Date().toISOString(), outcome: outcome ?? null })
    .eq("call_control_id", callControlId);
  if (error) console.error("finalizeCallLog failed:", error.message);
}

export async function attachRecordingUrl(callControlId: string, recordingUrl: string) {
  const { error } = await supabase
    .from("voice_agent_calls")
    .update({ recording_url: recordingUrl })
    .eq("call_control_id", callControlId);
  if (error) console.error("attachRecordingUrl failed:", error.message);
}
