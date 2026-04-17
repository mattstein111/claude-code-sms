/**
 * Access control — blocklist and owner verification.
 *
 * access.json is re-read on every check so changes take effect immediately.
 * Supports glob-style wildcards on E.164 phone numbers (e.g. "+1416*").
 *
 * Gate order (inbound): dm policy disabled → blocklist → owner (full trust) → untrusted (allow).
 *
 * There is no inbound allowlist — any non-blocked number reaches the session and the
 * model decides what to do (respond, ignore, escalate). Outbound sends are always allowed.
 */

import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { normalizePhone } from "./phone";

const STATE_DIR =
  process.env.SMS_STATE_DIR || join(process.env.HOME!, ".claude/channels/sms");
const ACCESS_PATH = join(STATE_DIR, "access.json");

export interface AccessConfig {
  dmPolicy: "enabled" | "disabled";
  blockList: string[];
  textChunkLimit: number;
  chunkMode: "length" | "newline";
}

export type GateResult =
  | { action: "allow"; trust: "owner" }
  | { action: "allow"; trust: "untrusted" }
  | { action: "drop"; reason: string };

const DEFAULT_CONFIG: AccessConfig = {
  dmPolicy: "enabled",
  blockList: [],
  textChunkLimit: 160,
  chunkMode: "length",
};

/** Read access.json, falling back to defaults if missing. */
export function readAccess(): AccessConfig {
  try {
    const raw = readFileSync(ACCESS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Legacy "allowlist" policy is treated as "enabled" (allowlist was removed).
    const dmPolicy = parsed.dmPolicy === "disabled" ? "disabled" : "enabled";
    const { allowFrom: _legacyAllowFrom, ...rest } = parsed;
    return {
      ...DEFAULT_CONFIG,
      ...rest,
      dmPolicy,
    };
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

/**
 * Match a phone number against a pattern with optional trailing wildcard.
 * Supports exact match ("+14165551234") and prefix match ("+1416*").
 * No regex — immune to ReDoS.
 */
function matchPattern(phone: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return phone === pattern;
  }

  const prefix = pattern.slice(0, pattern.indexOf("*"));
  return phone.startsWith(prefix);
}

/** Check if a phone number matches any pattern in a list. */
function matchesAny(phone: string, patterns: string[]): boolean {
  return patterns.some((p) => matchPattern(phone, p));
}

/** Get the owner phone number from env, normalized to E.164. */
export function getOwnerPhone(): string | null {
  const raw = process.env.OWNER_PHONE;
  if (!raw) return null;
  try {
    return normalizePhone(raw);
  } catch {
    return null;
  }
}

/**
 * Gate check for inbound messages.
 * Drops on disabled policy or blocklist; allows everything else.
 * Owner numbers are flagged with full trust; all others are untrusted.
 */
export function gate(phone: string): GateResult {
  const config = readAccess();

  if (config.dmPolicy === "disabled") {
    return { action: "drop", reason: "dm_policy_disabled" };
  }

  if (matchesAny(phone, config.blockList)) {
    return { action: "drop", reason: "blocklisted" };
  }

  const owner = getOwnerPhone();
  if (owner && phone === owner) {
    return { action: "allow", trust: "owner" };
  }

  return { action: "allow", trust: "untrusted" };
}
