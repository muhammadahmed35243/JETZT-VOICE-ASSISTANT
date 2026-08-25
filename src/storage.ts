import { supabase } from "./supabase/client";
import { attachRecordingUrl } from "./calls/callLog";

// Mirrors the dialer's lib/storage.ts pattern exactly (docs/voice-agent-plan.md
// calls for reusing it, not building a parallel one) — download the
// Telnyx-hosted recording, re-upload it into Supabase Storage, store a
// signed URL instead of Telnyx's own (which isn't meant to be a permanent
// public link). Same "recordings" bucket as the dialer, since both share
// one Supabase project — voice-agent/ prefix keeps the two apart.

const RECORDING_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 90; // 90 days

async function downloadFile(url: string, authHeader?: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to download file: ${response.status} ${response.statusText} - ${body.slice(0, 500)}`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadRecordingToStorage(
  path: string,
  data: Buffer,
  contentType: string = "audio/mpeg"
): Promise<{ path: string; url: string }> {
  const { data: uploadData, error } = await supabase.storage
    .from("recordings")
    .upload(path, data, { contentType });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  // The bucket is private (same as the dialer's), so getPublicUrl() would
  // produce a URL that never resolves — a signed URL is required.
  const { data: signedData, error: signError } = await supabase.storage
    .from("recordings")
    .createSignedUrl(uploadData.path, RECORDING_URL_EXPIRY_SECONDS);

  if (signError) throw new Error(`Failed to create signed URL: ${signError.message}`);

  return { path: uploadData.path, url: signedData.signedUrl };
}

export async function saveRecordingForCall(callControlId: string, telnyxRecordingUrl: string) {
  // No Authorization header here — confirmed directly against a real
  // failure that Telnyx's recording_urls are already presigned S3 URLs
  // (X-Amz-Algorithm/Signature in the query string). Adding a Bearer
  // header on top gets rejected by S3: "Only one auth mechanism allowed."
  // The dialer's downloadFile() takes an optional authHeader for other
  // callers that need it; this one just doesn't.
  const recordingData = await downloadFile(telnyxRecordingUrl);

  const now = new Date();
  const dateFolder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const storagePath = `voice-agent/${dateFolder}/call_${callControlId}.mp3`;

  const { url } = await uploadRecordingToStorage(storagePath, recordingData);
  await attachRecordingUrl(callControlId, url);
}
