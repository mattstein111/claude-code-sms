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
 *   2. Normalize phone numbers
 *   3. Deduplicate on provider message ID
 *   4. Download MMS media to local storage
 *   5. Write message row to SQLite
 *   6. Log everything to logs/listener.log
 *
 * Usage: bun run listener.ts
 * Config: ~/.claude/channels/sms/.env
 */

import { join } from "path";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { normalizePhone } from "./phone";
import { getDb, insertInbound, closeDb } from "./db";
import { getProvider } from "./providers/index";
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
      // Sanitize messageId for use in filenames
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

// --- Initialize DB ---

getDb();
log("info", "Webhook listener starting", {
  port: LISTEN_PORT,
  path: WEBHOOK_PATH,
  provider: provider.name,
});

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
    // Clone the request so the provider can read the body
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

    // Return 200 immediately — most providers don't retry
    // Process asynchronously
    processInbound(inbound).catch((err) => {
      log("error", "Webhook processing error", { error: String(err) });
    });

    return new Response("ok", { status: 200 });
  },
});

async function processInbound(msg: InboundMessage): Promise<void> {
  const phone = normalizePhone(msg.from);

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

  // Insert to database (deduplicates on provider message ID)
  const rowId = insertInbound(
    phone,
    msg.message,
    msg.providerMessageId,
    localMediaPaths.join(","),
    new Date().toISOString()
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
