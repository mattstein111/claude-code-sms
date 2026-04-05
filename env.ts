/**
 * Shared .env file loader.
 *
 * Reads key=value pairs from the state directory .env file.
 * Handles quoted values and comments.
 */

import { join } from "path";
import { existsSync } from "fs";

const STATE_DIR =
  process.env.SMS_STATE_DIR || join(process.env.HOME!, ".claude/channels/sms");

export const ENV_PATH = join(STATE_DIR, "env");
export { STATE_DIR };

/** Load .env from the state directory into process.env. */
export async function loadEnv(): Promise<void> {
  const envPath = join(STATE_DIR, ".env");
  if (!existsSync(envPath)) return;

  const envContent = await Bun.file(envPath).text();
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
