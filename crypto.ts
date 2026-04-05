/**
 * Cryptographic utilities for secure comparison and validation.
 *
 * All secret comparisons (webhook tokens, HMAC signatures) MUST use
 * constantTimeEquals() to prevent timing side-channel attacks.
 */

import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison.
 * Returns true if both strings are equal, without leaking timing information
 * about which characters match.
 *
 * Returns false if either value is empty/null/undefined.
 */
export function constantTimeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time comparison for base64-encoded values (e.g., HMAC signatures).
 */
export function constantTimeEqualsBase64(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;

  try {
    const bufA = Buffer.from(a, "base64");
    const bufB = Buffer.from(b, "base64");

    if (bufA.length !== bufB.length) return false;

    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
