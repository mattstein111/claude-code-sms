/**
 * Plivo SMS/MMS provider.
 *
 * API: POST-based REST at https://api.plivo.com/v1/Account/{auth_id}/Message/
 * Auth: HTTP Basic (Auth ID : Auth Token)
 * Webhooks: POST with application/json or application/x-www-form-urlencoded
 * Phone format: E.164 without + prefix (14165551234)
 *
 * Required env vars:
 *   PLIVO_AUTH_ID       — Plivo auth ID
 *   PLIVO_AUTH_TOKEN    — Plivo auth token
 *   PLIVO_PHONE_NUMBER  — Plivo phone number in E.164
 *   SMS_WEBHOOK_TOKEN   — secret token for webhook URL validation
 *
 * Optional:
 *   PLIVO_SIGNATURE_V3_TOKEN — for V3 webhook signature validation (mandatory if set)
 *
 * Docs: https://www.plivo.com/docs/sms/api/message
 *
 * Status: UNTESTED — implementation based on Plivo API documentation.
 *         See GitHub issue for testing status.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { createHmac } from "crypto";
import { constantTimeEquals, constantTimeEqualsBase64 } from "../crypto";

const API_BASE = "https://api.plivo.com/v1/Account";

function getConfig() {
  return {
    authId: process.env.PLIVO_AUTH_ID!,
    authToken: process.env.PLIVO_AUTH_TOKEN!,
    phoneNumber: process.env.PLIVO_PHONE_NUMBER!,
    signatureToken: process.env.PLIVO_SIGNATURE_V3_TOKEN,
  };
}

function basicAuth(id: string, token: string): string {
  return "Basic " + btoa(`${id}:${token}`);
}

function toPlivoFormat(e164: string): string {
  return e164.replace("+", "");
}

export const plivoProvider: SmsProvider = {
  name: "plivo",
  webhookMethod: "POST",

  validateConfig() {
    const required = ["PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN", "PLIVO_PHONE_NUMBER"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Plivo: missing env vars: ${missing.join(", ")}`);
    }
    // At least one form of webhook authentication is required
    if (!process.env.PLIVO_SIGNATURE_V3_TOKEN && !process.env.SMS_WEBHOOK_TOKEN) {
      throw new Error(
        "Plivo: at least one of PLIVO_SIGNATURE_V3_TOKEN or SMS_WEBHOOK_TOKEN must be set for webhook authentication"
      );
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();
    const url = `${API_BASE}/${config.authId}/Message/`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config.authId, config.authToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: toPlivoFormat(config.phoneNumber),
        dst: toPlivoFormat(to),
        text: message,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Plivo API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as {
      message_uuid: string[];
      message?: string;
    };
    return { id: data.message_uuid?.[0] || "" };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();
    const url = `${API_BASE}/${config.authId}/Message/`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config.authId, config.authToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: toPlivoFormat(config.phoneNumber),
        dst: toPlivoFormat(to),
        text: message,
        type: "mms",
        media_urls: mediaUrls,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Plivo API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { message_uuid: string[] };
    return { id: data.message_uuid?.[0] || "" };
  },

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    if (req.method !== "POST") return null;

    // Check optional token in query string (constant-time)
    const webhookToken = process.env.SMS_WEBHOOK_TOKEN;
    if (webhookToken) {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (!constantTimeEquals(token, webhookToken)) return null;
    }

    // Read body ONCE for both signature validation and parsing
    const rawBody = await req.text();

    // Plivo V3 signature validation — MANDATORY when token is configured
    const config = getConfig();
    if (config.signatureToken) {
      const signature = req.headers.get("x-plivo-signature-v3");
      const nonce = req.headers.get("x-plivo-signature-v3-nonce");
      if (!signature || !nonce) return null; // reject unsigned

      // Use WEBHOOK_BASE_URL if set (required behind a proxy/tunnel)
      const baseUrl = process.env.WEBHOOK_BASE_URL;
      const localUrl = new URL(req.url);
      const requestUrl = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}${localUrl.pathname}${localUrl.search}`
        : localUrl.toString();
      const dataToSign = requestUrl + nonce + rawBody;
      const expected = createHmac("sha256", config.signatureToken)
        .update(dataToSign)
        .digest("base64");
      if (!constantTimeEqualsBase64(signature, expected)) return null;
    }

    const contentType = req.headers.get("content-type") || "";
    let params: Record<string, unknown>;

    if (contentType.includes("application/json")) {
      try {
        params = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return null; // malformed JSON
      }
    } else {
      params = Object.fromEntries(new URLSearchParams(rawBody));
    }

    const from = (params.From as string) || "";
    const to = (params.To as string) || "";
    const message = (params.Text as string) || "";
    const messageUuid = (params.MessageUUID as string) || "";

    if (!from || !messageUuid) return null;

    const mediaUrls: string[] = [];
    const numMedia = parseInt((params.NumMedia as string) || "0", 10);
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`] as string;
      if (url) mediaUrls.push(url);
    }

    return {
      from: from.startsWith("+") ? from : `+${from}`,
      to: to.startsWith("+") ? to : `+${to}`,
      message,
      providerMessageId: messageUuid,
      mediaUrls,
    };
  },

  getFromNumber(): string {
    return process.env.PLIVO_PHONE_NUMBER!;
  },

  async fetchMedia(): Promise<string[]> {
    return [];
  },
};
