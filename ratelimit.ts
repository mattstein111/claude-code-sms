/**
 * In-memory rate limiting.
 *
 * Two layers:
 *   1. Per-phone sliding window — tracks message timestamps per number
 *   2. Global requests-per-second — caps total inbound request rate
 *
 * Both operate entirely in memory with no disk I/O.
 * The per-phone map has a hard cap to prevent memory exhaustion
 * from attackers spoofing many unique numbers.
 */

// --- Per-phone rate limiter ---

interface Window {
  timestamps: number[];
}

const windows = new Map<string, Window>();
const MAX_TRACKED_PHONES = 10000;

/**
 * Check if a message from this phone should be allowed.
 * Returns true if allowed, false if rate-limited.
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
    // Hard cap on tracked phones to prevent memory exhaustion
    if (windows.size >= MAX_TRACKED_PHONES) {
      return false; // reject when map is full — safe default
    }
    window = { timestamps: [] };
    windows.set(phone, window);
  }

  // Prune entries older than 1 hour
  const cutoff = now - 60 * 60 * 1000;
  let i = 0;
  while (i < window.timestamps.length && window.timestamps[i] < cutoff) {
    i++;
  }
  if (i > 0) window.timestamps.splice(0, i);

  // Per-minute check
  const oneMinuteAgo = now - 60 * 1000;
  const lastMinuteCount = window.timestamps.filter((t) => t >= oneMinuteAgo).length;
  if (lastMinuteCount >= perMinute) {
    return false;
  }

  // Per-hour check
  if (window.timestamps.length >= perHour) {
    return false;
  }

  window.timestamps.push(now);
  return true;
}

/**
 * Clean up windows for phones that haven't sent anything in over an hour.
 * Call on a timer to reclaim memory.
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

// --- Global rate limiter ---

let globalTokens: number = 0;
let globalLastRefill: number = 0;
let globalMaxTokens: number = 50;
let globalRefillRate: number = 50; // tokens per second

/**
 * Initialize the global rate limiter.
 * @param maxRequestsPerSecond — max sustained requests per second
 */
export function initGlobalRateLimit(maxRequestsPerSecond: number): void {
  globalMaxTokens = maxRequestsPerSecond;
  globalRefillRate = maxRequestsPerSecond;
  globalTokens = maxRequestsPerSecond;
  globalLastRefill = Date.now();
}

/**
 * Check if the global rate limit allows a request.
 * Uses a token bucket algorithm — smooth and burst-tolerant.
 */
export function checkGlobalRateLimit(): boolean {
  const now = Date.now();
  const elapsed = (now - globalLastRefill) / 1000;
  globalTokens = Math.min(globalMaxTokens, globalTokens + elapsed * globalRefillRate);
  globalLastRefill = now;

  if (globalTokens < 1) return false;
  globalTokens -= 1;
  return true;
}
