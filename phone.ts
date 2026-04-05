/**
 * Phone number normalization utilities.
 *
 * All internal representation uses E.164 format (+1XXXXXXXXXX).
 * voip.ms API expects 11 digits without the + prefix.
 */

/** Normalize any phone string to E.164 format. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return `+${digits}`;
}

/** Convert E.164 to voip.ms format (11 digits, no +). */
export function toVoipMs(e164: string): string {
  return e164.replace("+", "");
}
