import nacl from "tweetnacl";
import { config } from "../config.js";

/**
 * Mirrors the dialer's verifyTelnyxSignature() in lib/telnyx.ts: Telnyx signs
 * webhooks with Ed25519, not HMAC. The signed message is
 * `{timestamp}|{raw request body}` — verify against the raw bytes Telnyx
 * actually sent, before any JSON/form parsing, or the signature won't match.
 */
export function verifyTelnyxSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined
): boolean {
  if (!signatureHeader || !timestampHeader) return false;

  const signedPayload = `${timestampHeader}|${rawBody.toString("utf8")}`;
  const signatureBytes = Buffer.from(signatureHeader, "base64");
  const publicKeyBytes = Buffer.from(config.telnyx.publicKey, "base64");

  try {
    return nacl.sign.detached.verify(
      Buffer.from(signedPayload, "utf8"),
      signatureBytes,
      publicKeyBytes
    );
  } catch {
    return false;
  }
}
