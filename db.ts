/**
 * SQLite database for SMS message storage.
 *
 * Shared between the webhook listener (writes inbound) and
 * the MCP server (reads inbound, writes outbound).
 *
 * Uses Bun's built-in SQLite driver (bun:sqlite).
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

  // WAL mode for concurrent reader/writer (listener + MCP server)
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");

  _db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      direction TEXT NOT NULL,
      phone TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      media TEXT DEFAULT '',
      voipms_id TEXT DEFAULT '',
      delivered INTEGER DEFAULT 0
    )
  `);

  _db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone)"
  );
  _db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(delivered, direction)"
  );
  _db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_voipms_id ON messages(voipms_id) WHERE voipms_id != ''"
  );

  return _db;
}

export interface MessageRow {
  id: number;
  timestamp: string;
  direction: string;
  phone: string;
  message: string;
  media: string;
  voipms_id: string;
  delivered: number;
}

/** Insert an inbound message. Returns the row ID, or null if duplicate. */
export function insertInbound(
  phone: string,
  message: string,
  voipmsId: string,
  media: string = "",
  timestamp?: string
): number | null {
  const db = getDb();
  const ts = timestamp || new Date().toISOString();

  try {
    const result = db
      .prepare(
        `INSERT INTO messages (timestamp, direction, phone, message, media, voipms_id)
         VALUES (?, 'in', ?, ?, ?, ?)`
      )
      .run(ts, phone, message, media, voipmsId);
    return Number(result.lastInsertRowid);
  } catch (err: any) {
    // Unique constraint on voipms_id — duplicate webhook delivery
    if (err.message?.includes("UNIQUE constraint")) return null;
    throw err;
  }
}

/** Insert an outbound message. Returns the row ID. */
export function insertOutbound(
  phone: string,
  message: string,
  media: string = ""
): number {
  const db = getDb();
  const ts = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO messages (timestamp, direction, phone, message, media, delivered)
       VALUES (?, 'out', ?, ?, ?, 1)`
    )
    .run(ts, phone, message, media);
  return Number(result.lastInsertRowid);
}

/** Fetch undelivered inbound messages, ordered by ID ascending. */
export function fetchUndelivered(): MessageRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, timestamp, direction, phone, message, media, voipms_id, delivered
       FROM messages
       WHERE delivered = 0 AND direction = 'in'
       ORDER BY id ASC`
    )
    .all() as MessageRow[];
}

/** Mark a message as delivered. */
export function markDelivered(id: number): void {
  const db = getDb();
  db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?").run(id);
}

/** Fetch recent messages for a phone number. */
export function fetchMessages(phone: string, limit: number = 30): MessageRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, timestamp, direction, phone, message, media, voipms_id, delivered
       FROM messages
       WHERE phone = ?
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
        `SELECT id, timestamp, direction, phone, message, media, voipms_id, delivered
         FROM messages WHERE id = ?`
      )
      .get(id) as MessageRow) || null
  );
}

/** Close the database connection. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
