/**
 * Webhook listener — persistent HTTP server for inbound SMS/MMS.
 *
 * Runs independently of Claude Code as a systemd service so no messages
 * are lost when Claude Code isn't running. Most providers fire webhooks
 * once with no retry, so this must always be up.
 *
 * Provider-agnostic: uses the SmsProvider interface to parse webhooks
 * and fetch media. The active provider is set via SMS_PROVIDER env var.
 *
 * Security layers (in order):
 *   1. Listen address binding (default 127.0.0.1 — behind tunnel)
 *   2. Request body size limit (1MB)
 *   3. Webhook path validation (constant-time)
 *   4. Global rate limit (requests per second)
 *   5. Provider-level authentication (signatures, tokens)
 *   6. Phone number validation
 *   7. Per-phone rate limit (sliding window)
 *   8. Deduplication on provider message ID
 *   9. SSRF protection on media downloads
 *  10. Media size limits
 *
 * Usage: bun run listener.ts
 * Config: ~/.claude/channels/sms/.env
 */

import { join } from "path";
import { mkdirSync, appendFileSync, chmodSync } from "fs";
import { resolve as dnsResolve } from "dns/promises";
import { normalizePhone } from "./phone";
import { getDb, insertInbound, closeDb, purgeOldMessages } from "./db";
import { getProvider } from "./providers/index";
import {
  checkRateLimit,
  checkGlobalRateLimit,
  initGlobalRateLimit,
  cleanupStaleWindows,
} from "./ratelimit";
import { constantTimeEquals } from "./crypto";
import { loadEnv, STATE_DIR } from "./env";
import type { InboundMessage } from "./providers/interface";

// --- Configuration ---

await loadEnv();

const WEBHOOK_PATH = process.env.SMS_WEBHOOK_PATH || "/incoming";
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || "5090", 10);
const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const MEDIA_DIR = join(STATE_DIR, "media");
const LOG_DIR = join(STATE_DIR, "logs");
const LOG_PATH = join(LOG_DIR, "listener.log");

// Validate TLS config — both or neither
if ((TLS_CERT_PATH && !TLS_KEY_PATH) || (!TLS_CERT_PATH && TLS_KEY_PATH)) {
  console.error("FATAL: Both TLS_CERT_PATH and TLS_KEY_PATH must be set, or neither.");
  process.exit(1);
}
const TLS_ENABLED = !!(TLS_CERT_PATH && TLS_KEY_PATH);

// Request limits
const MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024; // 1MB
const GLOBAL_RATE_LIMIT = parseInt(process.env.GLOBAL_RATE_LIMIT || "50", 10);

// Per-phone rate limiting
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "10", 10);
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || "100", 10);

// Retention
const RETENTION_MAX_PER_PHONE = parseInt(process.env.RETENTION_MAX_PER_PHONE || "1000", 10);
const RETENTION_MAX_DAYS = parseInt(process.env.RETENTION_MAX_DAYS || "180", 10);
const RETENTION_BLOCKED_DAYS = parseInt(process.env.RETENTION_BLOCKED_DAYS || "3", 10);

// Ensure directories exist with restrictive permissions
mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

// --- Initialize provider and global rate limiter ---

const provider = getProvider();
initGlobalRateLimit(GLOBAL_RATE_LIMIT);

// --- Logging ---

function log(level: string, msg: string, data?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  });
  appendFileSync(LOG_PATH, entry + "\n");
  // Restrict log file permissions (phone numbers are logged)
  try { chmodSync(LOG_PATH, 0o600); } catch { /* may fail */ }
  if (level === "error") {
    console.error(`[${level}] ${msg}`);
  }
}

// --- Media download ---

const MAX_MEDIA_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_MEDIA_PER_MESSAGE = 10;

/**
 * Check if an IP address is private/reserved.
 * Covers IPv4, IPv6, mapped IPv6 (::ffff:), and special addresses.
 */
function isPrivateIp(ip: string): boolean {
  // Normalize: strip brackets from IPv6
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();

  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (addr.startsWith("::ffff:")) {
    return isPrivateIp(addr.slice(7));
  }

  // IPv6 private ranges
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7
  if (addr.startsWith("fe80")) return true; // link-local

  // IPv4
  if (addr === "0.0.0.0") return true;
  if (addr === "127.0.0.1" || addr.startsWith("127.")) return true;
  if (addr.startsWith("10.")) return true;
  if (addr.startsWith("192.168.")) return true;
  if (addr.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;

  return false;
}

/**
 * Validate a media URL and resolve DNS to pin the IP.
 * Returns { pinnedUrl, originalHost } if safe, null if blocked.
 *
 * Replaces the hostname with a resolved IP to defeat DNS rebinding.
 * Sets the Host header to the original hostname for TLS/vhost.
 */
async function resolveAndValidateMediaUrl(rawUrl: string): Promise<{ pinnedUrl: string; originalHost: string } | null> {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // Block obvious private hostnames
    if (host === "localhost" || host === "0.0.0.0") return null;
    if (host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (host === "metadata.google.internal") return null;

    // Check if host is a raw IP address
    if (isPrivateIp(host)) return null;

    // Block decimal (2130706433) and hex (0x7f000001) IP encodings
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return null;

    // Resolve hostname and validate all addresses
    let resolvedIp: string;
    try {
      const addresses = await dnsResolve(host);
      for (const addr of addresses) {
        if (isPrivateIp(addr)) return null;
      }
      resolvedIp = addresses[0];
    } catch {
      return null;
    }

    // Pin the URL to the resolved IP to defeat DNS rebinding
    const pinnedUrl = new URL(rawUrl);
    pinnedUrl.hostname = resolvedIp;

    return { pinnedUrl: pinnedUrl.toString(), originalHost: host };
  } catch {
    return null;
  }
}

async function downloadMedia(
  urls: string[],
  messageId: string
): Promise<string[]> {
  const localPaths: string[] = [];
  const limit = Math.min(urls.length, MAX_MEDIA_PER_MESSAGE);

  for (let i = 0; i < limit; i++) {
    const url = urls[i].trim();
    if (!url) continue;

    // SSRF protection — resolve DNS, validate IPs, pin to resolved address
    const resolved = await resolveAndValidateMediaUrl(url);
    if (!resolved) {
      log("warn", "Blocked media URL (SSRF protection)", { url });
      continue;
    }

    try {
      // Fetch using pinned IP to defeat DNS rebinding
      const resp = await fetch(resolved.pinnedUrl, {
        headers: { Host: resolved.originalHost },
      });
      if (!resp.ok) {
        log("error", "Failed to download media", { url, status: resp.status });
        continue;
      }

      const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_MEDIA_SIZE) {
        log("warn", "Media too large, skipped", { url, size: contentLength });
        continue;
      }

      const buffer = await resp.arrayBuffer();
      if (buffer.byteLength > MAX_MEDIA_SIZE) {
        log("warn", "Media too large after download, discarded", { url, size: buffer.byteLength });
        continue;
      }

      const contentType = resp.headers.get("content-type") || "application/octet-stream";
      const rawExt = contentType.split("/").pop()?.split(";")[0] || "bin";
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "bin";
      const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${safeId}_${i}.${ext}`;
      const filePath = join(MEDIA_DIR, filename);

      await Bun.write(filePath, buffer);
      // Restrict media file permissions
      try { chmodSync(filePath, 0o600); } catch { /* may fail */ }

      localPaths.push(filePath);
      log("info", "Downloaded media", { url, filePath, size: buffer.byteLength });
    } catch (err) {
      log("error", "Media download error", { url, error: String(err) });
    }
  }

  return localPaths;
}

// --- Initialize DB and run startup purge ---

getDb();

const purged = purgeOldMessages(RETENTION_MAX_PER_PHONE, RETENTION_MAX_DAYS, RETENTION_BLOCKED_DAYS);
if (purged > 0) {
  log("info", "Startup purge", {
    deleted: purged,
    maxPerPhone: RETENTION_MAX_PER_PHONE,
    maxDays: RETENTION_MAX_DAYS,
    blockedDays: RETENTION_BLOCKED_DAYS,
  });
}

log("info", "Webhook listener starting", {
  host: LISTEN_HOST,
  port: LISTEN_PORT,
  path: WEBHOOK_PATH,
  provider: provider.name,
  globalRateLimit: GLOBAL_RATE_LIMIT,
  rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
  rateLimitPerHour: RATE_LIMIT_PER_HOUR,
});

// --- Periodic maintenance ---

setInterval(() => {
  try {
    const deleted = purgeOldMessages(RETENTION_MAX_PER_PHONE, RETENTION_MAX_DAYS, RETENTION_BLOCKED_DAYS);
    if (deleted > 0) {
      log("info", "Periodic purge", { deleted });
    }
  } catch (err) {
    log("error", "Purge failed", { error: String(err) });
  }
}, 24 * 60 * 60 * 1000);

setInterval(cleanupStaleWindows, 10 * 60 * 1000);

// --- HTTP Server ---

const serverOptions: Parameters<typeof Bun.serve>[0] = {
  port: LISTEN_PORT,
  hostname: LISTEN_HOST,

  async fetch(req) {
    const url = new URL(req.url);

    // Health check (exact path, no timing leak)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Webhook path — constant-time comparison to prevent path brute-forcing
    if (!constantTimeEquals(url.pathname, WEBHOOK_PATH)) {
      return new Response("not found", { status: 404 });
    }

    // HTTP method check
    const allowedMethods = provider.webhookMethod.split("|");
    if (!allowedMethods.includes(req.method)) {
      return new Response("method not allowed", { status: 405 });
    }

    // Global rate limit — protect against volumetric attacks
    if (!checkGlobalRateLimit()) {
      return new Response("too many requests", { status: 429 });
    }

    // Request body size limit — enforced for both Content-Length and chunked encoding
    const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_REQUEST_BODY_SIZE) {
      return new Response("payload too large", { status: 413 });
    }

    // Read body with size cap to prevent chunked encoding bypass
    let bodyBytes: ArrayBuffer;
    try {
      bodyBytes = await req.arrayBuffer();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (bodyBytes.byteLength > MAX_REQUEST_BODY_SIZE) {
      return new Response("payload too large", { status: 413 });
    }

    // Reconstruct request with the already-read body for the provider
    const safeReq = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: bodyBytes.byteLength > 0 ? bodyBytes : undefined,
    });

    // Delegate parsing and validation to the provider
    let inbound: InboundMessage | null;
    try {
      inbound = await provider.parseWebhook(safeReq);
    } catch (err) {
      log("error", "Webhook parse error", { error: String(err) });
      return new Response("bad request", { status: 400 });
    }

    if (!inbound) {
      log("warn", "Webhook rejected by provider", {
        remote: req.headers.get("x-forwarded-for") || "unknown",
      });
      return new Response("unauthorized", { status: 401 });
    }

    // Normalize phone number — reject garbage
    let phone: string;
    try {
      phone = normalizePhone(inbound.from);
    } catch {
      log("warn", "Invalid phone number in webhook", { from: inbound.from });
      return new Response("ok", { status: 200 });
    }

    // Per-phone rate limit — before any DB write
    if (!checkRateLimit(phone, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_HOUR)) {
      log("warn", "Rate limited", { phone });
      return new Response("ok", { status: 200 });
    }

    // Return 200 immediately — most providers don't retry
    processInbound(inbound, phone).catch((err) => {
      log("error", "Webhook processing error", { error: String(err) });
    });

    return new Response("ok", { status: 200 });
  },
};

// Enable TLS if cert and key are configured
if (TLS_ENABLED) {
  serverOptions.tls = {
    cert: Bun.file(TLS_CERT_PATH),
    key: Bun.file(TLS_KEY_PATH),
  };
}

const server = Bun.serve(serverOptions);

async function processInbound(msg: InboundMessage, phone: string): Promise<void> {
  log("info", "Inbound message", {
    from: phone,
    to: msg.to,
    providerMessageId: msg.providerMessageId,
    hasMedia: msg.mediaUrls.length > 0,
    messageLength: msg.message.length,
  });

  let mediaUrls = msg.mediaUrls;
  if (mediaUrls.length === 0 && msg.providerMessageId) {
    try {
      mediaUrls = await provider.fetchMedia(msg.providerMessageId);
    } catch (err) {
      log("error", "fetchMedia fallback failed", {
        providerMessageId: msg.providerMessageId,
        error: String(err),
      });
    }
  }

  let localMediaPaths: string[] = [];
  if (mediaUrls.length > 0) {
    localMediaPaths = await downloadMedia(mediaUrls, msg.providerMessageId);
  }

  let did = "";
  try {
    did = msg.to ? normalizePhone(msg.to) : "";
  } catch {
    // DID normalization failure is non-fatal — just leave it empty
  }

  const rowId = insertInbound(
    phone,
    msg.message,
    msg.providerMessageId,
    localMediaPaths.join(","),
    new Date().toISOString(),
    did
  );

  if (rowId === null) {
    log("info", "Duplicate webhook, skipped", {
      providerMessageId: msg.providerMessageId,
    });
    return;
  }

  log("info", "Message stored", {
    rowId,
    phone,
    mediaCount: localMediaPaths.length,
  });
}

// --- Graceful shutdown ---

function shutdown() {
  log("info", "Shutting down webhook listener");
  server.stop();
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const proto = TLS_ENABLED ? "https" : "http";
log("info", "Webhook listener ready", {
  host: LISTEN_HOST,
  port: LISTEN_PORT,
  path: WEBHOOK_PATH,
  provider: provider.name,
  tls: TLS_ENABLED,
});
console.log(`SMS webhook listener running on ${proto}://${LISTEN_HOST}:${LISTEN_PORT} (provider: ${provider.name}${TLS_ENABLED ? ", TLS enabled" : ""})`);
