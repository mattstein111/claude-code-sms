/**
 * Webhook listener — persistent HTTP server for inbound SMS/MMS from voip.ms.
 *
 * Runs independently of Claude Code as a systemd service so no messages
 * are lost when Claude Code isn't running. voip.ms fires webhooks once
 * with no retry, so this must always be up.
 *
 * Receives: GET requests at the configured webhook path with query params
 *   - to, from, message, id, media, plus the webhook token
 *
 * Responsibilities:
 *   1. Validate webhook token
 *   2. Normalize phone numbers
 *   3. Deduplicate on voip.ms message ID
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
import { getDb, insertInbound } from "./db";
import { getMMS } from "./voipms";

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

const WEBHOOK_TOKEN = process.env.SMS_WEBHOOK_TOKEN;
const WEBHOOK_PATH = process.env.SMS_WEBHOOK_PATH || "/incoming";
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || "5090", 10);
const MEDIA_DIR = join(STATE_DIR, "media");
const LOG_DIR = join(STATE_DIR, "logs");
const LOG_PATH = join(LOG_DIR, "listener.log");

if (!WEBHOOK_TOKEN) {
  console.error("FATAL: SMS_WEBHOOK_TOKEN not set in .env");
  process.exit(1);
}

// Ensure directories exist
mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

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
  voipmsId: string
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
      const filename = `${voipmsId}_${i}.${ext}`;
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

/**
 * Attempt to fetch MMS media via the voip.ms getMMS API.
 * Fallback when the webhook doesn't include media URLs.
 */
async function fetchMmsMedia(voipmsId: string): Promise<string[]> {
  try {
    const resp = await getMMS(voipmsId);
    const media = resp.media as string | undefined;
    if (media) {
      return media.split(",").filter(Boolean);
    }
  } catch (err) {
    log("error", "getMMS API fallback failed", {
      voipmsId,
      error: String(err),
    });
  }
  return [];
}

// --- Initialize DB ---

getDb();
log("info", "Webhook listener starting", { port: LISTEN_PORT, path: WEBHOOK_PATH });

// --- HTTP Server ---

const server = Bun.serve({
  port: LISTEN_PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Only accept the configured webhook path
    if (url.pathname !== WEBHOOK_PATH) {
      return new Response("not found", { status: 404 });
    }

    // Only GET (voip.ms sends GET webhooks)
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }

    // Validate webhook token
    const token = url.searchParams.get("token");
    if (token !== WEBHOOK_TOKEN) {
      log("warn", "Invalid webhook token", {
        remote: req.headers.get("x-forwarded-for") || "unknown",
      });
      return new Response("unauthorized", { status: 401 });
    }

    // Return 200 immediately — voip.ms doesn't retry
    // Process asynchronously
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const message = decodeURIComponent(url.searchParams.get("message") || "");
    const voipmsId = url.searchParams.get("id") || "";
    const mediaParam = url.searchParams.get("media") || "";

    // Fire and forget — process in background
    processWebhook(from, to, message, voipmsId, mediaParam).catch((err) => {
      log("error", "Webhook processing error", { error: String(err) });
    });

    return new Response("ok", { status: 200 });
  },
});

async function processWebhook(
  from: string,
  to: string,
  message: string,
  voipmsId: string,
  mediaParam: string
): Promise<void> {
  const phone = normalizePhone(from);

  log("info", "Inbound message", {
    from: phone,
    to,
    voipmsId,
    hasMedia: !!mediaParam,
    messageLength: message.length,
  });

  // Resolve media URLs
  let mediaUrls: string[] = [];
  if (mediaParam) {
    mediaUrls = mediaParam.split(",").filter(Boolean);
  }

  // Fallback: try getMMS API if no media in webhook but ID suggests MMS
  if (mediaUrls.length === 0 && voipmsId) {
    mediaUrls = await fetchMmsMedia(voipmsId);
  }

  // Download media locally
  let localMediaPaths: string[] = [];
  if (mediaUrls.length > 0) {
    localMediaPaths = await downloadMedia(mediaUrls, voipmsId);
  }

  // Insert to database (deduplicates on voipms_id)
  const rowId = insertInbound(
    phone,
    message,
    voipmsId,
    localMediaPaths.join(","),
    new Date().toISOString()
  );

  if (rowId === null) {
    log("info", "Duplicate webhook, skipped", { voipmsId });
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
  const { closeDb } = require("./db");
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log("info", "Webhook listener ready", {
  port: LISTEN_PORT,
  path: WEBHOOK_PATH,
});
console.log(`SMS webhook listener running on port ${LISTEN_PORT}`);
