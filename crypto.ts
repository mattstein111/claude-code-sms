/**
 * Cryptographic utilities for secure comparison and validation.
 *
 * All secret comparisons (webhook tokens, HMAC signatures, webhook paths)
 * MUST use the functions in this module to prevent timing side-channels.
 *
 * Uses HMAC-then-compare pattern: both values are HMACed with a random
 * session key before comparison. This ensures:
 *   1. Comparison is always constant-time (timingSafeEqual on equal-length digests)
 *   2. No length oracle (HMAC output is always 32 bytes regardless of input length)
 */

import { timingSafeEqual, createHmac, randomBytes } from "crypto";

// Random key generated at process startup — used to normalize inputs
// for constant-time comparison. Not a secret for authentication purposes,
// just ensures equal-length buffers for timingSafeEqual.
const SESSION_KEY = randomBytes(32);

/**
 * Compute HMAC-SHA256 of a value using the session key.
 * Returns a fixed 32-byte Buffer regardless of input length.
 */
function hmac(value: string): Buffer {
  return createHmac("sha256", SESSION_KEY).update(value).digest();
}

/**
 * Constant-time string comparison with no length oracle.
 * Both values are HMACed to fixed-length digests before comparison.
 *
 * Returns false if either value is empty/null/undefined.
 */
export function constantTimeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;

  const hmacA = hmac(a);
  const hmacB = hmac(b);

  return timingSafeEqual(hmacA, hmacB);
}

/**
 * Constant-time comparison for base64-encoded values (e.g., HMAC signatures).
 * Decodes from base64 then compares via HMAC-then-timingSafeEqual.
 */
export function constantTimeEqualsBase64(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;

  try {
    // Decode base64 to raw bytes, then re-encode as hex for consistent string comparison
    const strA = Buffer.from(a, "base64").toString("hex");
    const strB = Buffer.from(b, "base64").toString("hex");

    const hmacA = hmac(strA);
    const hmacB = hmac(strB);

    return timingSafeEqual(hmacA, hmacB);
  } catch {
    return false;
  }
}
