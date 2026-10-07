// One-time helper: turns the JETZT portal's stored Google refresh token into
// the plain value the voice agent needs as GOOGLE_CALENDAR_REFRESH_TOKEN.
//
// 1. In the PORTAL's Supabase SQL editor:
//      select encrypted_refresh_token from integration_credentials where provider = 'google_calendar';
// 2. Run (PowerShell):
//      $env:TOKEN_ENCRYPTION_KEY="<portal's key>"; node scripts/decrypt-portal-token.mjs "v1.xxxx.xxxx.xxxx"
//
// Same AES-256-GCM "v1.<iv>.<tag>.<ciphertext>" format as the portal's
// lib/crypto.ts. Prints the token to your terminal only — paste it into
// Vercel, don't commit it.
import { createDecipheriv } from "node:crypto";

const raw = process.env.TOKEN_ENCRYPTION_KEY;
const payload = process.argv[2];
if (!raw || !payload) {
  console.error('Usage: TOKEN_ENCRYPTION_KEY=<key> node scripts/decrypt-portal-token.mjs "v1...."');
  process.exit(1);
}

const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
const [version, iv, tag, data] = payload.trim().split(".");
if (key.length !== 32 || version !== "v1" || !iv || !tag || !data) {
  console.error("Key must be 32 bytes and the value must look like v1.<iv>.<tag>.<data>");
  process.exit(1);
}

const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
decipher.setAuthTag(Buffer.from(tag, "base64url"));
console.log(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8"));
