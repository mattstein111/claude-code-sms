/**
 * SQLite database for SMS message storage.
 *
 * Shared between the webhook listener (writes inbound) and
 * one or more MCP server instances (read inbound, write outbound).
 *
 * Uses Bun's built-in SQLite driver (bun:sqlite).
 *
 * ## Multi-instance design
 *
 * The `messages` table is a pure append-only log. Delivery tracking is
 * per-session via the `sessions` and `deliveries` tables. Each MCP server
 * registers a session on startup and independently tracks which messages
 * it has delivered. This means:
 *   - Multiple Claude Code sessions see the same inbound messages
 *   - A late-starting session catches up from scratch
 *   - Sessions can subscribe to specific DIDs
 *
 * ## Retention
 *
 * Per counterparty phone number:
 *   - Keep the last RETENTION_MAX_PER_PHONE messages (default 1000)
 *   - Only if sent within RETENTION_MAX_DAYS (default 180)
 *   - Blocked messages purge after RETENTION_BLOCKED_DAYS (default 3)
 *
 * The `did` column records which local number sent/received the message.
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const STATE_DIR =
  process.env.SMS_STATE_DIR || join(process.env.HOME!, ".claude/channels/sms");
const DB_PATH = join(STATE_DIR, "sms.db");

let _db: Database | null = null;

/** Get or create the shared database connection. */
export function getDb(): Database {
  if (_db) return _db;

  _db = new Database(DB_PATH, { create: true });

  // WAL mode for concurrent reader/writer (listener + multiple MCP servers)
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");

  // --- Messages: append-only log ---

  _db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      phone TEXT NOT NULL,
      did TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      media TEXT DEFAULT '',
      provider_msg_id TEXT DEFAULT '',
      blocked INTEGER NOT NULL DEFAULT 0
    )
  `);

  // --- Migration from old schema ---
  // Rename voipms_id -> provider_msg_id if old schema exists
  // Add blocked column, remove delivered column
  // These are safe to call repeatedly (silently fail if already migrated)
  try { _db.run("ALTER TABLE messages RENAME COLUMN voipms_id TO provider_msg_id"); } catch { /* already renamed or doesn't exist */ }
  try { _db.run("ALTER TABLE messages ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { _db.run("ALTER TABLE messages ADD COLUMN did TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  // Migrate old delivered=-1 rows to blocked=1
  try { _db.run("UPDATE messages SET blocked = 1 WHERE delivered = -1"); } catch { /* delivered column gone */ }
  // We leave the old 'delivered' column in place if it exists — harmless, avoids DROP COLUMN compat issues

  // --- Sessions: one row per MCP server instance ---

  _db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_poll TEXT,
      dids TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      hwm INTEGER NOT NULL DEFAULT 0
    )
  `);

  // --- Deliveries: per-session, per-message tracking ---

  _db.run(`
    CREATE TABLE IF NOT EXISTS deliveries (
      session_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, message_id)
    )
  `);

  // Indexes
  _db.run("CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone)");
  _db.run("CREATE INDEX IF NOT EXISTS idx_messages_direction_blocked ON messages(direction, blocked)");
  _db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_msg_id ON messages(provider_msg_id) WHERE provider_msg_id != ''");
  _db.run("CREATE INDEX IF NOT EXISTS idx_deliveries_session ON deliveries(session_id, message_id)");

  return _db;
}

export interface MessageRow {
  id: number;
  timestamp: string;
  direction: string;
  phone: string;
  did: string;
  message: string;
  media: string;
  provider_msg_id: string;
  blocked: number;
}

// --- Webhook listener operations (write-only) ---

/** Insert an inbound message. Returns the row ID, or null if duplicate. */
export function insertInbound(
  phone: string,
  message: string,
  providerMessageId: string,
  media: string = "",
  timestamp?: string,
  did: string = ""
): number | null {
  const db = getDb();
  const ts = timestamp || new Date().toISOString();

  try {
    const result = db
      .prepare(
        `INSERT INTO messages (timestamp, direction, phone, did, message, media, provider_msg_id)
         VALUES (?, 'in', ?, ?, ?, ?, ?)`
      )
      .run(ts, phone, did, message, media, providerMessageId);
    return Number(result.lastInsertRowid);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) return null;
    throw err;
  }
}

/** Insert an outbound message. Returns the row ID. */
export function insertOutbound(
  phone: string,
  message: string,
  media: string = "",
  did: string = ""
): number {
  const db = getDb();
  const ts = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO messages (timestamp, direction, phone, did, message, media)
       VALUES (?, 'out', ?, ?, ?, ?)`
    )
    .run(ts, phone, did, message, media);
  return Number(result.lastInsertRowid);
}

/** Mark a message as blocked (stored for audit, never delivered). */
export function markBlocked(id: number): void {
  const db = getDb();
  db.prepare("UPDATE messages SET blocked = 1 WHERE id = ?").run(id);
}

// --- Session management (MCP server) ---

/** Register a new session. Returns the session ID. */
export function registerSession(sessionId: string, dids: string[] | null): void {
  const db = getDb();
  const didsStr = dids ? dids.join(",") : null;

  db.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, started_at, last_poll, dids, active, hwm)
     VALUES (?, datetime('now'), datetime('now'), ?, 1, 0)`
  ).run(sessionId, didsStr);
}

/** Update the session's last poll time and high-water mark. */
export function updateSessionPoll(sessionId: string, hwm: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET last_poll = datetime('now'), hwm = ? WHERE session_id = ?"
  ).run(hwm, sessionId);
}

/** Mark a session as inactive (graceful shutdown). */
export function deactivateSession(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE sessions SET active = 0 WHERE session_id = ?").run(sessionId);
}

/**
 * Fetch undelivered inbound messages for a session.
 * Uses high-water mark for efficiency, falls back to deliveries table for edge cases.
 * Filters by DID if the session subscribes to specific numbers.
 */
export function fetchUndeliveredForSession(
  sessionId: string,
  dids: string[] | null
): MessageRow[] {
  const db = getDb();

  // Get session's high-water mark
  const session = db
    .prepare("SELECT hwm FROM sessions WHERE session_id = ?")
    .get(sessionId) as { hwm: number } | null;
  const hwm = session?.hwm ?? 0;

  let query: string;
  const params: unknown[] = [];

  if (dids && dids.length > 0) {
    const placeholders = dids.map(() => "?").join(",");
    query = `
      SELECT m.id, m.timestamp, m.direction, m.phone, m.did, m.message, m.media, m.provider_msg_id, m.blocked
      FROM messages m
      LEFT JOIN deliveries d ON d.message_id = m.id AND d.session_id = ?
      WHERE m.blocked = 0
        AND m.direction = 'in'
        AND m.id > ?
        AND d.message_id IS NULL
        AND m.did IN (${placeholders})
      ORDER BY m.id ASC
      LIMIT 50
    `;
    params.push(sessionId, hwm, ...dids);
  } else {
    query = `
      SELECT m.id, m.timestamp, m.direction, m.phone, m.did, m.message, m.media, m.provider_msg_id, m.blocked
      FROM messages m
      LEFT JOIN deliveries d ON d.message_id = m.id AND d.session_id = ?
      WHERE m.blocked = 0
        AND m.direction = 'in'
        AND m.id > ?
        AND d.message_id IS NULL
      ORDER BY m.id ASC
      LIMIT 50
    `;
    params.push(sessionId, hwm);
  }

  return db.prepare(query).all(...params) as MessageRow[];
}

/** Record that a session has delivered a message. */
export function recordDelivery(sessionId: string, messageId: number): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO deliveries (session_id, message_id) VALUES (?, ?)"
  ).run(sessionId, messageId);
}

/** Batch record deliveries and update high-water mark. */
export function recordDeliveryBatch(
  sessionId: string,
  messageIds: number[]
): void {
  if (messageIds.length === 0) return;
  const db = getDb();

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO deliveries (session_id, message_id) VALUES (?, ?)"
  );

  const maxId = Math.max(...messageIds);

  db.transaction(() => {
    for (const id of messageIds) {
      stmt.run(sessionId, id);
    }
    updateSessionPoll(sessionId, maxId);
  })();
}

// --- Conversation history ---

/** Fetch recent messages for a phone number (excludes blocked). */
export function fetchMessages(phone: string, limit: number = 30): MessageRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, timestamp, direction, phone, did, message, media, provider_msg_id, blocked
       FROM messages
       WHERE phone = ? AND blocked = 0
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(phone, limit)
    .reverse() as MessageRow[];
}

/** Look up a message by ID. */
export function getMessage(id: number): MessageRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT id, timestamp, direction, phone, did, message, media, provider_msg_id, blocked
         FROM messages WHERE id = ?`
      )
      .get(id) as MessageRow) || null
  );
}

// --- Retention & cleanup ---

/**
 * Purge old messages and stale session data.
 *
 * For each counterparty phone number:
 *   - Keep the most recent `maxPerPhone` messages
 *   - Delete anything older than `maxDays` days
 *   - Blocked messages purge after `blockedDays`
 *
 * Also cleans up dead sessions and their delivery records.
 */
export function purgeOldMessages(
  maxPerPhone: number,
  maxDays: number,
  blockedDays: number
): number {
  const db = getDb();
  let total = 0;

  // 1. Purge blocked messages older than blockedDays
  if (blockedDays > 0) {
    const result = db
      .prepare(
        `DELETE FROM messages
         WHERE blocked = 1
         AND timestamp < datetime('now', '-' || ? || ' days')`
      )
      .run(blockedDays);
    total += result.changes;
  }

  // 2. Purge messages older than maxDays
  if (maxDays > 0) {
    const result = db
      .prepare(
        `DELETE FROM messages
         WHERE blocked = 0
         AND timestamp < datetime('now', '-' || ? || ' days')`
      )
      .run(maxDays);
    total += result.changes;
  }

  // 3. Per-phone: keep only the most recent maxPerPhone messages
  if (maxPerPhone > 0) {
    const phones = db
      .prepare("SELECT DISTINCT phone FROM messages WHERE blocked = 0")
      .all() as Array<{ phone: string }>;

    for (const { phone } of phones) {
      const result = db
        .prepare(
          `DELETE FROM messages
           WHERE phone = ?
           AND blocked = 0
           AND id NOT IN (
             SELECT id FROM messages
             WHERE phone = ? AND blocked = 0
             ORDER BY id DESC
             LIMIT ?
           )`
        )
        .run(phone, phone, maxPerPhone);
      total += result.changes;
    }
  }

  // 4. Clean up stale sessions (inactive for over 7 days)
  db.run(
    `DELETE FROM deliveries WHERE session_id IN (
       SELECT session_id FROM sessions
       WHERE active = 0 AND last_poll < datetime('now', '-7 days')
     )`
  );
  db.run(
    `DELETE FROM sessions
     WHERE active = 0 AND last_poll < datetime('now', '-7 days')`
  );

  // 5. Mark crashed sessions as inactive (no poll in over 1 hour)
  db.run(
    `UPDATE sessions SET active = 0
     WHERE last_poll < datetime('now', '-1 hour') AND active = 1`
  );

  // 6. Clean up delivery records for purged messages
  db.run(
    `DELETE FROM deliveries WHERE message_id NOT IN (SELECT id FROM messages)`
  );

  return total;
}

/** Close the database connection. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
