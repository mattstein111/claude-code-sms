/**
 * Access control — allowlist, blocklist, and owner verification.
 *
 * access.json is re-read on every check so changes take effect immediately.
 * Supports glob-style wildcards on E.164 phone numbers (e.g. "+1416*").
 *
 * Gate order: blocklist (drop) → owner (full trust) → allowlist (untrusted) → drop.
 */

import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

const STATE_DIR =
  process.env.SMS_STATE_DIR || join(process.env.HOME!, ".claude/channels/sms");
const ACCESS_PATH = join(STATE_DIR, "access.json");

export interface AccessConfig {
  dmPolicy: "allowlist" | "disabled";
  allowFrom: string[];
  blockList: string[];
  textChunkLimit: number;
  chunkMode: "length" | "newline";
}

export type GateResult =
  | { action: "allow"; trust: "owner" }
  | { action: "allow"; trust: "untrusted" }
  | { action: "drop"; reason: string };

const DEFAULT_CONFIG: AccessConfig = {
  dmPolicy: "allowlist",
  allowFrom: [],
  blockList: [],
  textChunkLimit: 160,
  chunkMode: "length",
};

/** Read access.json, falling back to defaults if missing. */
export function readAccess(): AccessConfig {
  try {
    const raw = readFileSync(ACCESS_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Write access.json atomically via tmp+rename. */
export function writeAccess(config: AccessConfig): void {
  const tmpPath = ACCESS_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(tmpPath, ACCESS_PATH);
}

/** Match a phone number against a pattern that may contain wildcards. */
function matchPattern(phone: string, pattern: string): boolean {
  // Convert glob pattern to regex: * becomes .*
  const regex = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  );
  return regex.test(phone);
}

/** Check if a phone number matches any pattern in a list. */
function matchesAny(phone: string, patterns: string[]): boolean {
  return patterns.some((p) => matchPattern(phone, p));
}

/** Get the owner phone number from env. */
export function getOwnerPhone(): string | null {
  return process.env.OWNER_PHONE || null;
}

/**
 * Gate check for inbound messages.
 * Returns the action to take and trust level.
 */
export function gate(phone: string): GateResult {
  const config = readAccess();

  if (config.dmPolicy === "disabled") {
    return { action: "drop", reason: "dm_policy_disabled" };
  }

  // Blocklist always checked first
  if (matchesAny(phone, config.blockList)) {
    return { action: "drop", reason: "blocklisted" };
  }

  // Owner gets full trust
  const owner = getOwnerPhone();
  if (owner && phone === owner) {
    return { action: "allow", trust: "owner" };
  }

  // Allowlist check
  if (matchesAny(phone, config.allowFrom)) {
    return { action: "allow", trust: "untrusted" };
  }

  return { action: "drop", reason: "not_on_allowlist" };
}
