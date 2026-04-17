/**
 * Configuration engine for the generic "other" SMS provider.
 *
 * Loads a JSON config file that describes any REST-based SMS provider's
 * API shape — endpoints, auth, field mappings, phone format. Users pick
 * a "type" preset that pre-configures the request/webhook shape, then
 * fill in their provider-specific details.
 *
 * Config file: ~/.claude/channels/sms/other-provider.json
 *
 * Supported types:
 *   basic_json  — Basic auth + JSON body (Bandwidth, ClickSend, BulkSMS, etc.)
 *   bearer_json — Bearer token + JSON body (Sinch, Telnyx token-only, etc.)
 *   apikey_json — Custom API key header + JSON body (Infobip, MessageBird, etc.)
 *   basic_form  — Basic auth + form-encoded body (Twilio-like)
 *   query_get   — Credentials in query params + GET (voip.ms-like)
 *   custom      — Full manual configuration
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { STATE_DIR } from "../env";

// --- Types ---

export type ProviderType =
  | "basic_json"
  | "bearer_json"
  | "apikey_json"
  | "basic_form"
  | "query_get"
  | "custom";

export type PhoneFormat = "e164" | "digits" | "national";

export type WebhookAuthType = "token_query" | "token_header" | "basic" | "none";

export interface WebhookAuth {
  type: WebhookAuthType;
  /** Query param name for token_query (default: "token") */
  param?: string;
  /** Header name for token_header */
  header?: string;
  /** Env var holding the secret (default: SMS_WEBHOOK_TOKEN) */
  env_var?: string;
}

export interface SendConfig {
  /** API endpoint URL. Supports {{env.VAR}} templates. */
  url: string;
  /** HTTP method (default: POST, or GET for query_get type). */
  method?: "GET" | "POST";
  /** Headers. Values support {{env.VAR}} templates. */
  headers?: Record<string, string>;
  /** Auth config for basic/bearer types (used by type presets). */
  auth?: {
    /** Env var for username (basic auth) */
    username_env?: string;
    /** Env var for password/secret (basic auth) */
    password_env?: string;
    /** Env var for bearer token */
    token_env?: string;
    /** Env var for API key */
    apikey_env?: string;
    /** Header name for API key (default: "Authorization") */
    apikey_header?: string;
  };
  /** Body template — object with {{to}}, {{from}}, {{message}} placeholders. */
  body?: Record<string, unknown>;
  /** Body format: "json" or "form" (default inferred from type). */
  body_format?: "json" | "form";
  /** Field name where MMS media URL array is inserted (null = no MMS). */
  mms_media_field?: string | null;
  /** Dot-notation path to extract message ID from response JSON. */
  response_id_path?: string;
  /** Phone number format (default: "e164"). */
  phone_format?: PhoneFormat;
}

/**
 * Shallow overrides applied on top of `send` when firing an MMS request.
 * Used when the provider's MMS endpoint differs from its SMS endpoint
 * (e.g. voip.ms: same URL, `body.method` flips from `sendSMS` → `sendMMS`).
 * Any field present here replaces the same field in `send`; fields from
 * `send.body` and `mms.body` are shallow-merged (mms wins).
 */
export interface MmsConfig {
  url?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  body_format?: "json" | "form";
  response_id_path?: string;
}

/**
 * How to handle messages longer than a single SMS segment.
 * See providers/interface.ts for a full description of each strategy.
 */
export type LongMessageStrategyName = "passthrough" | "mms_fallback" | "chunk";

export interface WebhookConfig {
  /** HTTP method(s) for inbound webhooks. */
  method?: "GET" | "POST" | "GET|POST";
  /** Content type: "json", "form", or "query". */
  content_type?: "json" | "form" | "query";
  /** Webhook authentication. */
  auth?: WebhookAuth;
  /** Field mapping: our field names → provider's field names. Dot-notation for nesting. */
  fields?: {
    from?: string;
    to?: string;
    message?: string;
    message_id?: string;
    media_urls?: string;
  };
}

export interface OtherProviderConfig {
  /** Provider type preset. */
  type: ProviderType;
  /** Display name for this provider. */
  name: string;
  /** From phone number in E.164. */
  from_number: string;
  /** Outbound send configuration. */
  send: SendConfig;
  /**
   * Optional overrides applied on top of `send` when firing an MMS request.
   * Required when `long_message_strategy` is `"mms_fallback"` and the
   * provider's MMS API differs from its SMS API.
   */
  mms?: MmsConfig;
  /** Inbound webhook configuration. */
  webhook?: WebhookConfig;
  /** Media fetch — null/absent = not supported. */
  fetch_media?: null;
  /**
   * How to handle messages longer than `long_message_threshold`.
   * Default: `"passthrough"` (send the full body as-is; works for any
   * provider whose API handles multipart SMS natively with UDH — Twilio,
   * Telnyx, Plivo, Sinch, MessageBird, Vonage, etc.).
   *
   * Set `"mms_fallback"` for providers like voip.ms that cap sendSMS at
   * 160 chars without concatenation but have a separate MMS API that
   * accepts longer text. Requires an `mms` config block.
   *
   * Set `"chunk"` as a last resort — DIY-splits the body at
   * `long_message_threshold` and sends each slice as an independent SMS.
   * Recipients will see fragmented, possibly reordered messages.
   */
  long_message_strategy?: LongMessageStrategyName;
  /**
   * Max chars a single SMS segment may contain before
   * `long_message_strategy` triggers. Default: 160.
   */
  long_message_threshold?: number;
}

// --- Config loading and validation ---

const CONFIG_PATH = join(STATE_DIR, "other-provider.json");

let cachedConfig: OtherProviderConfig | null = null;

export function loadConfig(): OtherProviderConfig {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Generic provider config not found: ${CONFIG_PATH}\n` +
        `Create this file to configure your SMS provider. See other-provider.example.json for format.`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${CONFIG_PATH}: ${err}`);
  }

  let config: OtherProviderConfig;
  try {
    config = JSON.parse(raw) as OtherProviderConfig;
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${err}`);
  }

  validateConfig(config);
  applyTypeDefaults(config);
  cachedConfig = config;
  return config;
}

/** Reset cached config (for testing). */
export function resetConfigCache(): void {
  cachedConfig = null;
}

const VALID_TYPES: ProviderType[] = [
  "basic_json",
  "bearer_json",
  "apikey_json",
  "basic_form",
  "query_get",
  "custom",
];

const VALID_PHONE_FORMATS: PhoneFormat[] = ["e164", "digits", "national"];

function validateConfig(config: OtherProviderConfig): void {
  if (!config.type || !VALID_TYPES.includes(config.type)) {
    throw new Error(
      `other-provider.json: "type" must be one of: ${VALID_TYPES.join(", ")}`
    );
  }
  if (!config.name) {
    throw new Error(`other-provider.json: "name" is required`);
  }
  if (!config.from_number || !config.from_number.startsWith("+")) {
    throw new Error(
      `other-provider.json: "from_number" must be E.164 format (e.g. "+14165551234")`
    );
  }
  if (!config.send || !config.send.url) {
    throw new Error(`other-provider.json: "send.url" is required`);
  }

  // Validate phone format if specified
  if (config.send.phone_format && !VALID_PHONE_FORMATS.includes(config.send.phone_format)) {
    throw new Error(
      `other-provider.json: "send.phone_format" must be one of: ${VALID_PHONE_FORMATS.join(", ")}`
    );
  }

  // Validate long_message_strategy if specified
  const VALID_STRATEGIES: LongMessageStrategyName[] = ["passthrough", "mms_fallback", "chunk"];
  if (
    config.long_message_strategy &&
    !VALID_STRATEGIES.includes(config.long_message_strategy)
  ) {
    throw new Error(
      `other-provider.json: "long_message_strategy" must be one of: ${VALID_STRATEGIES.join(", ")}`
    );
  }
  if (config.long_message_strategy === "mms_fallback" && !config.mms) {
    throw new Error(
      `other-provider.json: long_message_strategy "mms_fallback" requires an "mms" config block`
    );
  }
  if (
    config.long_message_threshold !== undefined &&
    (typeof config.long_message_threshold !== "number" || config.long_message_threshold < 1)
  ) {
    throw new Error(
      `other-provider.json: "long_message_threshold" must be a positive number`
    );
  }

  // Validate auth config based on type
  if (config.type === "basic_json" || config.type === "basic_form") {
    if (!config.send.auth?.username_env || !config.send.auth?.password_env) {
      throw new Error(
        `other-provider.json: type "${config.type}" requires send.auth.username_env and send.auth.password_env`
      );
    }
  }
  if (config.type === "bearer_json") {
    if (!config.send.auth?.token_env) {
      throw new Error(
        `other-provider.json: type "bearer_json" requires send.auth.token_env`
      );
    }
  }
  if (config.type === "apikey_json") {
    if (!config.send.auth?.apikey_env) {
      throw new Error(
        `other-provider.json: type "apikey_json" requires send.auth.apikey_env`
      );
    }
  }

  // Validate all {{env.VAR}} references resolve
  const envRefs = extractEnvRefs(config);
  const missing = envRefs.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `other-provider.json: missing env vars referenced in config: ${missing.join(", ")}`
    );
  }
}

/** Apply type-specific defaults to the config. */
function applyTypeDefaults(config: OtherProviderConfig): void {
  const send = config.send;
  const webhook = config.webhook || (config.webhook = {});

  switch (config.type) {
    case "basic_json":
      send.method = send.method || "POST";
      send.body_format = send.body_format || "json";
      webhook.method = webhook.method || "POST";
      webhook.content_type = webhook.content_type || "json";
      break;

    case "bearer_json":
      send.method = send.method || "POST";
      send.body_format = send.body_format || "json";
      webhook.method = webhook.method || "POST";
      webhook.content_type = webhook.content_type || "json";
      break;

    case "apikey_json":
      send.method = send.method || "POST";
      send.body_format = send.body_format || "json";
      webhook.method = webhook.method || "POST";
      webhook.content_type = webhook.content_type || "json";
      break;

    case "basic_form":
      send.method = send.method || "POST";
      send.body_format = send.body_format || "form";
      webhook.method = webhook.method || "POST";
      webhook.content_type = webhook.content_type || "form";
      break;

    case "query_get":
      send.method = send.method || "GET";
      send.body_format = send.body_format || "json"; // unused for GET
      webhook.method = webhook.method || "GET";
      webhook.content_type = webhook.content_type || "query";
      break;

    case "custom":
      send.method = send.method || "POST";
      send.body_format = send.body_format || "json";
      webhook.method = webhook.method || "POST";
      webhook.content_type = webhook.content_type || "json";
      break;
  }

  // Default webhook auth
  if (!webhook.auth) {
    webhook.auth = { type: "token_query", param: "token", env_var: "SMS_WEBHOOK_TOKEN" };
  }
  webhook.auth.env_var = webhook.auth.env_var || "SMS_WEBHOOK_TOKEN";
  if (webhook.auth.type === "token_query") {
    webhook.auth.param = webhook.auth.param || "token";
  }

  // Default phone format
  send.phone_format = send.phone_format || "e164";

  // Default response ID path
  send.response_id_path = send.response_id_path || "id";
}

// --- Template engine ---

/**
 * Resolve {{var}} templates in a string.
 *
 * Supported variables:
 *   {{to}}       — destination phone (formatted per phone_format)
 *   {{from}}     — from phone (formatted per phone_format)
 *   {{message}}  — message text
 *   {{env.VAR}}  — environment variable
 */
export function resolveTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (key.startsWith("env.")) {
      const envVar = key.slice(4);
      return process.env[envVar] || "";
    }
    return vars[key] ?? "";
  });
}

/**
 * Recursively resolve templates in an object/array/string.
 * Returns a deep copy with all {{var}} placeholders replaced.
 */
export function resolveTemplateDeep(
  value: unknown,
  vars: Record<string, string>
): unknown {
  if (typeof value === "string") {
    return resolveTemplate(value, vars);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplateDeep(v, vars));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[resolveTemplate(k, vars)] = resolveTemplateDeep(v, vars);
    }
    return result;
  }
  return value;
}

// --- Phone format converter ---

/**
 * Convert an E.164 phone number to the configured format.
 */
export function formatPhone(e164: string, format: PhoneFormat): string {
  switch (format) {
    case "e164":
      return e164;
    case "digits":
      return e164.replace("+", "");
    case "national":
      // Strip country code — assumes +1 for North America
      if (e164.startsWith("+1") && e164.length === 12) {
        return e164.slice(2);
      }
      return e164.replace("+", "");
    default:
      return e164;
  }
}

// --- Dot-path resolver ---

/**
 * Extract a value from a nested object using dot-notation path.
 * e.g., getByPath({ data: { id: "123" } }, "data.id") => "123"
 *
 * Returns undefined if any intermediate key is missing.
 */
export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// --- Env var extraction ---

/**
 * Find all {{env.VAR}} references in the config for validation.
 */
function extractEnvRefs(config: OtherProviderConfig): string[] {
  const refs = new Set<string>();

  function scan(value: unknown): void {
    if (typeof value === "string") {
      const matches = value.matchAll(/\{\{env\.(\w+)\}\}/g);
      for (const m of matches) {
        refs.add(m[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(scan);
    }
  }

  scan(config.send);
  if (config.mms) scan(config.mms);

  // Also check auth env var references
  const auth = config.send.auth;
  if (auth) {
    if (auth.username_env) refs.add(auth.username_env);
    if (auth.password_env) refs.add(auth.password_env);
    if (auth.token_env) refs.add(auth.token_env);
    if (auth.apikey_env) refs.add(auth.apikey_env);
  }

  // Webhook auth env var
  const webhookAuth = config.webhook?.auth;
  if (webhookAuth?.env_var) refs.add(webhookAuth.env_var);

  return [...refs];
}

// --- Auth header builder ---

/**
 * Build the Authorization header value based on type preset and auth config.
 */
export function buildAuthHeaders(config: OtherProviderConfig): Record<string, string> {
  const auth = config.send.auth;
  if (!auth) return {};

  switch (config.type) {
    case "basic_json":
    case "basic_form": {
      const user = process.env[auth.username_env!] || "";
      const pass = process.env[auth.password_env!] || "";
      return { Authorization: "Basic " + btoa(`${user}:${pass}`) };
    }
    case "bearer_json": {
      const token = process.env[auth.token_env!] || "";
      return { Authorization: `Bearer ${token}` };
    }
    case "apikey_json": {
      const key = process.env[auth.apikey_env!] || "";
      const header = auth.apikey_header || "Authorization";
      return { [header]: key };
    }
    default:
      return {};
  }
}
