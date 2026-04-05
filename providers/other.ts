/**
 * Generic "other" SMS provider — config-driven via other-provider.json.
 *
 * Supports any REST-based SMS provider by describing its API shape in JSON.
 * Users pick a type preset (basic_json, bearer_json, apikey_json, basic_form,
 * query_get, custom) and fill in their provider-specific details.
 *
 * Webhook authentication: token-based only (no crypto signatures).
 * For providers needing signature validation, use the dedicated .ts providers.
 *
 * Config file: ~/.claude/channels/sms/other-provider.json
 * See other-provider.example.json for format.
 *
 * Status: NEW — requires testing with specific provider configurations.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import {
  loadConfig,
  resolveTemplate,
  resolveTemplateDeep,
  formatPhone,
  getByPath,
  buildAuthHeaders,
} from "./other-config";
import { constantTimeEquals } from "../crypto";

export const otherProvider: SmsProvider = {
  get name(): string {
    return loadConfig().name || "other";
  },

  get webhookMethod(): "GET" | "POST" | "GET|POST" {
    return loadConfig().webhook?.method || "POST";
  },

  validateConfig(): void {
    // loadConfig() performs full validation and throws descriptive errors
    loadConfig();
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    return send(to, message, []);
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = loadConfig();
    if (!config.send.mms_media_field) {
      throw new Error(`${config.name}: MMS not supported (no mms_media_field configured)`);
    }
    return send(to, message, mediaUrls);
  },

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    const config = loadConfig();
    const webhook = config.webhook;
    if (!webhook) return null;

    // Validate HTTP method
    const allowedMethods = (webhook.method || "POST").split("|");
    if (!allowedMethods.includes(req.method)) return null;

    // Webhook authentication
    const auth = webhook.auth;
    if (auth && auth.type !== "none") {
      const secret = process.env[auth.env_var || "SMS_WEBHOOK_TOKEN"] || "";
      if (!secret) return null; // No secret configured — reject all

      if (auth.type === "token_query") {
        const url = new URL(req.url);
        const token = url.searchParams.get(auth.param || "token");
        if (!constantTimeEquals(token, secret)) return null;
      } else if (auth.type === "token_header") {
        const token = req.headers.get(auth.header || "X-Webhook-Token");
        if (!constantTimeEquals(token, secret)) return null;
      } else if (auth.type === "basic") {
        const authHeader = req.headers.get("authorization") || "";
        if (!authHeader.startsWith("Basic ")) return null;
        if (!constantTimeEquals(authHeader.slice(6), secret)) return null;
      }
    }

    // Parse webhook body
    const contentType = webhook.content_type || "json";
    let data: Record<string, unknown>;

    if (contentType === "query") {
      const url = new URL(req.url);
      data = Object.fromEntries(url.searchParams.entries());
    } else if (contentType === "form") {
      const body = await req.text();
      data = Object.fromEntries(new URLSearchParams(body));
    } else {
      // json
      try {
        data = (await req.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    // Extract fields using configured mapping
    const fields = webhook.fields || {};
    const from = extractField(data, fields.from || "from");
    const to = extractField(data, fields.to || "to");
    const message = extractField(data, fields.message || "message");
    const messageId = extractField(data, fields.message_id || "message_id");

    if (!from || !messageId) return null;

    // Extract media URLs
    let mediaUrls: string[] = [];
    if (fields.media_urls) {
      const mediaValue = getByPath(data, fields.media_urls);
      if (Array.isArray(mediaValue)) {
        mediaUrls = mediaValue.filter((v): v is string => typeof v === "string");
      } else if (typeof mediaValue === "string" && mediaValue) {
        mediaUrls = mediaValue.split(",").filter(Boolean);
      }
    }

    return {
      from,
      to,
      message,
      providerMessageId: messageId,
      mediaUrls,
    };
  },

  getFromNumber(): string {
    return loadConfig().from_number;
  },

  async fetchMedia(): Promise<string[]> {
    // Not supported in generic provider v1
    return [];
  },
};

// --- Helpers ---

/**
 * Build and send an outbound request based on config.
 */
async function send(
  to: string,
  message: string,
  mediaUrls: string[]
): Promise<SendResult> {
  const config = loadConfig();
  const send = config.send;
  const phoneFormat = send.phone_format || "e164";

  const vars: Record<string, string> = {
    to: formatPhone(to, phoneFormat),
    from: formatPhone(config.from_number, phoneFormat),
    message,
  };

  // Build URL with template resolution
  const url = resolveTemplate(send.url, vars);

  // Build headers — start with type-based auth headers, then overlay configured headers
  const headers: Record<string, string> = {
    ...buildAuthHeaders(config),
  };
  if (send.headers) {
    for (const [key, value] of Object.entries(send.headers)) {
      headers[resolveTemplate(key, vars)] = resolveTemplate(value, vars);
    }
  }

  if (send.method === "GET") {
    // For GET requests, body fields become query params
    const reqUrl = new URL(url);
    if (send.body) {
      const resolved = resolveTemplateDeep(send.body, vars) as Record<string, unknown>;
      for (const [k, v] of Object.entries(resolved)) {
        if (v !== null && v !== undefined) {
          reqUrl.searchParams.set(k, String(v));
        }
      }
    }
    if (mediaUrls.length > 0 && send.mms_media_field) {
      mediaUrls.forEach((murl, i) => {
        reqUrl.searchParams.set(`${send.mms_media_field}${i + 1}`, murl);
      });
    }

    const resp = await fetch(reqUrl.toString(), { headers });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`${config.name} API HTTP ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const id = getByPath(data, send.response_id_path || "id");
    return { id: String(id ?? "") };
  }

  // POST request
  let body: string;
  if (send.body_format === "form") {
    headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    if (send.body) {
      const resolved = resolveTemplateDeep(send.body, vars) as Record<string, unknown>;
      for (const [k, v] of Object.entries(resolved)) {
        if (v !== null && v !== undefined) {
          params.set(k, String(v));
        }
      }
    }
    if (mediaUrls.length > 0 && send.mms_media_field) {
      for (const murl of mediaUrls) {
        params.append(send.mms_media_field, murl);
      }
    }
    body = params.toString();
  } else {
    // JSON
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    const resolved = resolveTemplateDeep(send.body || {}, vars) as Record<string, unknown>;
    if (mediaUrls.length > 0 && send.mms_media_field) {
      resolved[send.mms_media_field] = mediaUrls;
    }
    body = JSON.stringify(resolved);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`${config.name} API HTTP ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const id = getByPath(data, send.response_id_path || "id");
  return { id: String(id ?? "") };
}

/**
 * Extract a string field from webhook data using dot-notation path.
 * Handles URL-decoding for query param content.
 */
function extractField(data: Record<string, unknown>, path: string): string {
  const value = getByPath(data, path);
  if (value === null || value === undefined) return "";
  return String(value);
}
