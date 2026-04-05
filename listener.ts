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
 * Responsibilities:
 *   1. Validate webhook authenticity (delegated to provider)
 *   2. Rate-limit per phone number (in-memory, before DB write)
 *   3. Normalize phone numbers
 *   4. Deduplicate on provider message ID
 *   5. Download MMS media to local storage
 *   6. Write message row to SQLite
 *   7. Purge old messages on startup and daily
 *   8. Log everything to logs/listener.log
 *
 * Usage: bun run listener.ts
 * Config: ~/.claude/channels/sms/.env
 */

import { join } from "path";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { normalizePhone } from "./phone";
import { getDb, insertInbound, closeDb, purgeOldMessages } from "./db";
import { getProvider } from "./providers/index";
import { checkRateLimit, cleanupStaleWindows } from "./ratelimit";
import type { InboundMessage } from "./providers/interface";

// --- Configuration ---

const STATE_DIR =
  process.env.SMS_STATE_DIR || join(process.env.HOME!, ".claude/channels/sms");
const ENV_PATH = join(STATE_DIR, ".env");

// Load .env from state directory
if (existsSync(ENV_PATH)) {
  const envContent = await Bun.file(ENV_PATH).text();
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = value;
  }
}

const WEBHOOK_PATH = process.env.SMS_WEBHOOK_PATH || "/incoming";
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || "5090", 10);
const MEDIA_DIR = join(STATE_DIR, "media");
const LOG_DIR = join(STATE_DIR, "logs");
const LOG_PATH = join(LOG_DIR, "listener.log");

// Rate limiting
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "10", 10);
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || "100", 10);

// Retention
const RETENTION_MAX_PER_PHONE = parseInt(process.env.RETENTION_MAX_PER_PHONE || "1000", 10);
const RETENTION_MAX_DAYS = parseInt(process.env.RETENTION_MAX_DAYS || "180", 10);
const RETENTION_BLOCKED_DAYS = parseInt(process.env.RETENTION_BLOCKED_DAYS || "3", 10);

// Ensure directories exist
mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

// --- Initialize provider ---

const provider = getProvider();

// --- Logging ---

function log(level: string, msg: string, data?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  });
  appendFileSync(LOG_PATH, entry + "\n");
  if (level === "error") {
    console.error(`[${level}] ${msg}`);
  }
}

// --- Media download ---

async function downloadMedia(
  urls: string[],
  messageId: string
): Promise<string[]> {
  const localPaths: string[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    if (!url) continue;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log("error", "Failed to download media", { url, status: resp.status });
        continue;
      }

      const contentType = resp.headers.get("content-type") || "application/octet-stream";
      const ext = contentType.split("/").pop()?.split(";")[0] || "bin";
      const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${safeId}_${i}.${ext}`;
      const filePath = join(MEDIA_DIR, filename);

      const buffer = await resp.arrayBuffer();
      await Bun.write(filePath, buffer);

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
  port: LISTEN_PORT,
  path: WEBHOOK_PATH,
  provider: provider.name,
  rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
  rateLimitPerHour: RATE_LIMIT_PER_HOUR,
  retentionMaxPerPhone: RETENTION_MAX_PER_PHONE,
  retentionMaxDays: RETENTION_MAX_DAYS,
  retentionBlockedDays: RETENTION_BLOCKED_DAYS,
});

// --- Periodic maintenance ---

// Purge old messages daily
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

// Clean up stale rate limiter windows every 10 minutes
setInterval(cleanupStaleWindows, 10 * 60 * 1000);

// --- HTTP Server ---

const server = Bun.serve({
  port: LISTEN_PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", provider: provider.name }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only accept the configured webhook path
    if (url.pathname !== WEBHOOK_PATH) {
      return new Response("not found", { status: 404 });
    }

    // Check HTTP method against what the provider expects
    const allowedMethods = provider.webhookMethod.split("|");
    if (!allowedMethods.includes(req.method)) {
      return new Response("method not allowed", { status: 405 });
    }

    // Delegate parsing and validation to the provider
    let inbound: InboundMessage | null;
    try {
      inbound = await provider.parseWebhook(req);
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

    // Rate limit check — before any DB write
    const phone = normalizePhone(inbound.from);
    if (!checkRateLimit(phone, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_HOUR)) {
      log("warn", "Rate limited", { phone });
      return new Response("ok", { status: 200 }); // 200 so provider doesn't retry
    }

    // Return 200 immediately — most providers don't retry
    processInbound(inbound, phone).catch((err) => {
      log("error", "Webhook processing error", { error: String(err) });
    });

    return new Response("ok", { status: 200 });
  },
});

async function processInbound(msg: InboundMessage, phone: string): Promise<void> {
  log("info", "Inbound message", {
    from: phone,
    to: msg.to,
    providerMessageId: msg.providerMessageId,
    hasMedia: msg.mediaUrls.length > 0,
    messageLength: msg.message.length,
  });

  // If no media in webhook, try provider's fetchMedia fallback
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

  // Download media locally
  let localMediaPaths: string[] = [];
  if (mediaUrls.length > 0) {
    localMediaPaths = await downloadMedia(mediaUrls, msg.providerMessageId);
  }

  // Normalize the local DID that received this message
  const did = msg.to ? normalizePhone(msg.to) : "";

  // Insert to database (deduplicates on provider message ID)
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

log("info", "Webhook listener ready", {
  port: LISTEN_PORT,
  path: WEBHOOK_PATH,
  provider: provider.name,
});
console.log(`SMS webhook listener running on port ${LISTEN_PORT} (provider: ${provider.name})`);
