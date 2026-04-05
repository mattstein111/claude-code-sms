/**
 * In-memory sliding window rate limiter.
 *
 * Tracks message timestamps per phone number. Checks are O(1) amortized —
 * old entries are pruned lazily on each check. No DB access, no disk I/O.
 *
 * Used by the webhook listener to drop floods before they hit SQLite.
 */

interface Window {
  timestamps: number[];
}

const windows = new Map<string, Window>();

/** Prune timestamps older than `maxAgeMs` from the window. */
function prune(window: Window, maxAgeMs: number, now: number): void {
  const cutoff = now - maxAgeMs;
  // Find first index that's within the window
  let i = 0;
  while (i < window.timestamps.length && window.timestamps[i] < cutoff) {
    i++;
  }
  if (i > 0) {
    window.timestamps.splice(0, i);
  }
}

/**
 * Check if a message from this phone should be allowed.
 * Returns true if allowed, false if rate-limited.
 *
 * Automatically records the timestamp if allowed.
 */
export function checkRateLimit(
  phone: string,
  perMinute: number,
  perHour: number
): boolean {
  const now = Date.now();

  let window = windows.get(phone);
  if (!window) {
    window = { timestamps: [] };
    windows.set(phone, window);
  }

  // Prune entries older than 1 hour
  prune(window, 60 * 60 * 1000, now);

  // Count messages in the last minute
  const oneMinuteAgo = now - 60 * 1000;
  const lastMinuteCount = window.timestamps.filter((t) => t >= oneMinuteAgo).length;
  if (lastMinuteCount >= perMinute) {
    return false;
  }

  // Count messages in the last hour (already pruned to 1 hour)
  if (window.timestamps.length >= perHour) {
    return false;
  }

  // Allowed — record this message
  window.timestamps.push(now);
  return true;
}

/**
 * Periodically clean up windows for phones that haven't sent
 * anything in over an hour. Call this on a timer to prevent
 * unbounded memory growth from many unique numbers.
 */
export function cleanupStaleWindows(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [phone, window] of windows) {
    if (
      window.timestamps.length === 0 ||
      window.timestamps[window.timestamps.length - 1] < cutoff
    ) {
      windows.delete(phone);
    }
  }
}
