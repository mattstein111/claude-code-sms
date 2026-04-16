/**
 * Regression test for issue #14 — SMS message replay on MCP restart.
 *
 * Scenarios covered:
 *   1. Existing session (restart) does NOT re-deliver already-delivered messages
 *   2. New session bootstraps to the tip (no historical flood by default)
 *   3. SMS_REPLAY_ON_FIRST_START=full replays history for brand-new subscribers
 *   4. Stable session id is deterministic given the same inputs
 *   5. registerSession upsert preserves hwm on existing sessions
 *
 * Run with: SMS_STATE_DIR=/tmp/sms-test bun test_replay_fix.ts
 */

import { mkdirSync, rmSync, existsSync } from "fs";
import { createHash } from "crypto";

const TEST_DIR = "/tmp/claude-code-sms-test-replay-fix";
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
mkdirSync(TEST_DIR, { recursive: true });
process.env.SMS_STATE_DIR = TEST_DIR;

const {
  getDb,
  insertInbound,
  registerSession,
  fetchUndeliveredForSession,
  recordDeliveryBatch,
  getMaxMessageId,
  updateSessionPoll,
  closeDb,
} = await import("./db");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  OK   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures++;
  }
}

function newTestRun(): void {
  closeDb();
}

// --- Scenario 1: Restart of same session does not replay ---
console.log("\n[1] Restart of same session does not re-deliver messages");
{
  getDb();
  insertInbound("+15551111", "hello 1", "p1", "", undefined, "+15559999");
  insertInbound("+15551111", "hello 2", "p2", "", undefined, "+15559999");

  const SESSION = "test-stable-1";

  // First "run" — register, fetch, deliver
  let r1 = registerSession(SESSION, null);
  assert(r1.isNew === true, "first register reports isNew=true");

  // Simulate first-run bootstrap: replay=full, so don't seek to tip
  const rows1 = fetchUndeliveredForSession(SESSION, null);
  assert(rows1.length === 2, `first run delivers 2 messages (got ${rows1.length})`);
  recordDeliveryBatch(SESSION, rows1.map((r) => r.id));

  // Simulate restart
  let r2 = registerSession(SESSION, null);
  assert(r2.isNew === false, "second register reports isNew=false (session existed)");

  const rows2 = fetchUndeliveredForSession(SESSION, null);
  assert(rows2.length === 0, `restart delivers 0 messages (got ${rows2.length}) — REPLAY BUG`);

  // New message arrives after restart
  insertInbound("+15551111", "hello 3", "p3", "", undefined, "+15559999");
  const rows3 = fetchUndeliveredForSession(SESSION, null);
  assert(rows3.length === 1 && rows3[0].message === "hello 3", "new message after restart is delivered once");
  recordDeliveryBatch(SESSION, rows3.map((r) => r.id));
}
newTestRun();

// --- Scenario 2: New session bootstraps to tip (no historical flood) ---
console.log("\n[2] New session bootstrapped to tip skips history");
{
  getDb();
  insertInbound("+15552222", "old msg 1", "q1", "", undefined, "+15559999");
  insertInbound("+15552222", "old msg 2", "q2", "", undefined, "+15559999");
  const tipBefore = getMaxMessageId();
  assert(tipBefore >= 2, `tip is at least 2 after seeding (got ${tipBefore})`);

  const SESSION = "test-new-tip";
  const r = registerSession(SESSION, null);
  assert(r.isNew === true, "session is new");
  // Simulate server.ts bootstrap behaviour
  updateSessionPoll(SESSION, tipBefore);

  const rows = fetchUndeliveredForSession(SESSION, null);
  assert(rows.length === 0, `new session with tip-seek delivers 0 historical messages (got ${rows.length})`);

  insertInbound("+15552222", "brand new", "q3", "", undefined, "+15559999");
  const rows2 = fetchUndeliveredForSession(SESSION, null);
  assert(rows2.length === 1 && rows2[0].message === "brand new", "only post-subscribe message is delivered");
}
newTestRun();

// --- Scenario 3: SMS_REPLAY_ON_FIRST_START=full mode delivers history ---
console.log("\n[3] Full-replay mode delivers history to brand-new session");
{
  getDb();
  insertInbound("+15553333", "historical A", "r1", "", undefined, "+15559999");
  insertInbound("+15553333", "historical B", "r2", "", undefined, "+15559999");

  const SESSION = "test-full-replay";
  const r = registerSession(SESSION, null);
  assert(r.isNew === true, "session is new");
  // Simulate server.ts full-replay behaviour — do NOT bootstrap hwm

  const rows = fetchUndeliveredForSession(SESSION, null);
  // DB is shared across scenarios so we see all prior inbound too; what
  // matters is that the new session in full-replay mode sees historical
  // messages (i.e. the two we just inserted are in the set), rather than zero.
  assert(rows.length >= 2, `full-replay new session sees >= 2 messages (got ${rows.length})`);
  const gotA = rows.some((r) => r.message === "historical A");
  const gotB = rows.some((r) => r.message === "historical B");
  assert(gotA && gotB, "full-replay set includes both historical messages");
}
newTestRun();

// --- Scenario 4: Stable id derivation is deterministic ---
console.log("\n[4] Session id derivation is deterministic");
{
  function deriveForTest(stateDir: string, dids: string[] | null): string {
    const didsKey = dids && dids.length > 0 ? [...dids].sort().join(",") : "*";
    const h = createHash("sha1").update(`${stateDir}|${didsKey}`).digest("hex").slice(0, 16);
    return `auto-${h}`;
  }

  const a = deriveForTest("/foo", null);
  const b = deriveForTest("/foo", null);
  assert(a === b, `same inputs produce same id (${a})`);

  const c = deriveForTest("/bar", null);
  assert(a !== c, "different state dir produces different id");

  const d = deriveForTest("/foo", ["+1555", "+1666"]);
  const e = deriveForTest("/foo", ["+1666", "+1555"]);
  assert(d === e, "DID order does not matter (sorted)");

  assert(a !== d, "different DIDs produce different id");
}

// --- Scenario 5: registerSession preserves hwm on existing session ---
console.log("\n[5] registerSession does not clobber hwm on existing session");
{
  getDb();
  const SESSION = "test-preserve-hwm";
  registerSession(SESSION, null);
  updateSessionPoll(SESSION, 42);

  const r = registerSession(SESSION, null);
  assert(r.isNew === false, "second register sees existing session");

  const row = getDb()
    .prepare("SELECT hwm FROM sessions WHERE session_id = ?")
    .get(SESSION) as { hwm: number } | null;
  assert(row?.hwm === 42, `hwm preserved across re-registration (expected 42, got ${row?.hwm})`);
}
newTestRun();

// --- Cleanup ---
rmSync(TEST_DIR, { recursive: true });

console.log(failures === 0 ? "\nAll scenarios passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
