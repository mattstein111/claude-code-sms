/**
 * Twilio SMS/MMS provider.
 *
 * API: POST-based REST at https://api.twilio.com/2010-04-01/
 * Auth: HTTP Basic (Account SID : Auth Token)
 * Webhooks: POST with application/x-www-form-urlencoded body
 * Phone format: E.164 (+14165551234)
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID  — Twilio account SID (starts with AC)
 *   TWILIO_AUTH_TOKEN    — Twilio auth token
 *   TWILIO_PHONE_NUMBER  — Twilio phone number in E.164
 *   SMS_WEBHOOK_TOKEN    — optional extra token for webhook URL validation
 *
 * Webhook validation: Twilio signs webhooks with X-Twilio-Signature header
 * using HMAC-SHA1 of the request URL + sorted POST params, keyed with auth token.
 * Signature validation is MANDATORY — unsigned requests are rejected.
 *
 * Docs: https://www.twilio.com/docs/messaging/api
 *
 * Status: UNTESTED — implementation based on Twilio API documentation.
 *         See GitHub issue for testing status.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { createHmac } from "crypto";
import { constantTimeEquals, constantTimeEqualsBase64 } from "../crypto";

const API_BASE = "https://api.twilio.com/2010-04-01";

function getConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
    authToken: process.env.TWILIO_AUTH_TOKEN!,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER!,
  };
}

function basicAuth(sid: string, token: string): string {
  return "Basic " + btoa(`${sid}:${token}`);
}

/**
 * Validate Twilio webhook signature (constant-time).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
function validateSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return constantTimeEqualsBase64(signature, expected);
}

export const twilioProvider: SmsProvider = {
  name: "twilio",
  webhookMethod: "POST",

  validateConfig() {
    const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Twilio: missing env vars: ${missing.join(", ")}`);
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();
    const url = `${API_BASE}/Accounts/${config.accountSid}/Messages.json`;

    const body = new URLSearchParams({
      To: to,
      From: config.phoneNumber,
      Body: message,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config.accountSid, config.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Twilio API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return { id: data.sid as string };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();
    const url = `${API_BASE}/Accounts/${config.accountSid}/Messages.json`;

    if (mediaUrls.length > 10) {
      throw new Error("Twilio supports max 10 media URLs per MMS");
    }

    const body = new URLSearchParams({
      To: to,
      From: config.phoneNumber,
      Body: message,
    });
    for (const mediaUrl of mediaUrls) {
      body.append("MediaUrl", mediaUrl);
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config.accountSid, config.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Twilio API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return { id: data.sid as string };
  },

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    if (req.method !== "POST") return null;

    const config = getConfig();
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/x-www-form-urlencoded")) return null;

    const body = await req.text();
    const params = Object.fromEntries(new URLSearchParams(body));

    // Twilio signature is MANDATORY — reject unsigned requests
    const signature = req.headers.get("x-twilio-signature");
    if (!signature) return null;

    const requestUrl = new URL(req.url).toString();
    if (!validateSignature(config.authToken, signature, requestUrl, params)) {
      return null;
    }

    // Optional extra token in query string (defense in depth)
    const webhookToken = process.env.SMS_WEBHOOK_TOKEN;
    if (webhookToken) {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (!constantTimeEquals(token, webhookToken)) return null;
    }

    const from = params.From || "";
    const to = params.To || "";
    const message = params.Body || "";
    const messageSid = params.MessageSid || params.SmsSid || "";
    const numMedia = parseInt(params.NumMedia || "0", 10);

    if (!from || !messageSid) return null;

    const mediaUrls: string[] = [];
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      if (url) mediaUrls.push(url);
    }

    return {
      from,
      to,
      message,
      providerMessageId: messageSid,
      mediaUrls,
    };
  },

  getFromNumber(): string {
    return process.env.TWILIO_PHONE_NUMBER!;
  },

  async fetchMedia(providerMessageId: string): Promise<string[]> {
    const config = getConfig();
    const url = `${API_BASE}/Accounts/${config.accountSid}/Messages/${providerMessageId}/Media.json`;

    try {
      const resp = await fetch(url, {
        headers: { Authorization: basicAuth(config.accountSid, config.authToken) },
      });
      if (!resp.ok) return [];

      const data = (await resp.json()) as {
        media_list?: Array<{ uri: string }>;
      };
      if (!data.media_list) return [];

      return data.media_list.map(
        (m) => `https://api.twilio.com${m.uri.replace(".json", "")}`
      );
    } catch {
      return [];
    }
  },
};
