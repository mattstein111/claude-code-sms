/**
 * Vonage (formerly Nexmo) SMS/MMS provider.
 *
 * API: POST-based REST at https://rest.nexmo.com (SMS) and
 *      https://api.nexmo.com/v1/messages (Messages API for MMS)
 * Auth: API key + secret as query/body params (SMS API),
 *       or JWT/Basic auth (Messages API)
 * Webhooks: POST with JSON body (Messages API) or GET/POST with params (SMS API)
 * Phone format: E.164 without + prefix for SMS API, with + for Messages API
 *
 * Required env vars:
 *   VONAGE_API_KEY       — Vonage API key
 *   VONAGE_API_SECRET    — Vonage API secret
 *   VONAGE_PHONE_NUMBER  — Vonage virtual number in E.164
 *   SMS_WEBHOOK_TOKEN    — secret token for webhook URL validation
 *
 * Optional:
 *   VONAGE_SIGNATURE_SECRET — for webhook signature validation
 *
 * Docs: https://developer.vonage.com/en/messaging/sms/overview
 *       https://developer.vonage.com/en/messages/overview
 *
 * Status: UNTESTED — implementation based on Vonage API documentation.
 *         See GitHub issue for testing status.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { createHmac } from "crypto";

const SMS_API_BASE = "https://rest.nexmo.com";
const MESSAGES_API_BASE = "https://api.nexmo.com/v1/messages";

function getConfig() {
  return {
    apiKey: process.env.VONAGE_API_KEY!,
    apiSecret: process.env.VONAGE_API_SECRET!,
    phoneNumber: process.env.VONAGE_PHONE_NUMBER!,
    signatureSecret: process.env.VONAGE_SIGNATURE_SECRET,
  };
}

export const vonageProvider: SmsProvider = {
  name: "vonage",
  webhookMethod: "POST",

  validateConfig() {
    const required = ["VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_PHONE_NUMBER"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Vonage: missing env vars: ${missing.join(", ")}`);
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();

    // Use the SMS API for plain text messages
    const resp = await fetch(`${SMS_API_BASE}/sms/json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        from: config.phoneNumber.replace("+", ""),
        to: to.replace("+", ""),
        text: message,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Vonage SMS API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as {
      messages: Array<{ status: string; "message-id"?: string; "error-text"?: string }>;
    };

    const msg = data.messages?.[0];
    if (!msg || msg.status !== "0") {
      throw new Error(`Vonage SMS API error: ${msg?.["error-text"] || "unknown"}`);
    }

    return { id: msg["message-id"] || "" };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();

    // MMS requires the Messages API with basic auth
    const auth = "Basic " + btoa(`${config.apiKey}:${config.apiSecret}`);

    // Vonage Messages API sends one image per request — send text + first image,
    // then additional images as separate messages
    const resp = await fetch(MESSAGES_API_BASE, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message_type: "image",
        to: to,
        from: config.phoneNumber,
        channel: "mms",
        image: {
          url: mediaUrls[0],
          caption: message,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Vonage Messages API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { message_uuid: string };

    // Send remaining images as separate messages
    for (let i = 1; i < mediaUrls.length; i++) {
      await fetch(MESSAGES_API_BASE, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message_type: "image",
          to: to,
          from: config.phoneNumber,
          channel: "mms",
          image: { url: mediaUrls[i] },
        }),
      });
    }

    return { id: data.message_uuid };
  },

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    if (req.method !== "POST") return null;

    // Check optional token in query string
    const webhookToken = process.env.SMS_WEBHOOK_TOKEN;
    if (webhookToken) {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (token !== webhookToken) return null;
    }

    const contentType = req.headers.get("content-type") || "";
    let body: Record<string, unknown>;

    if (contentType.includes("application/json")) {
      body = (await req.json()) as Record<string, unknown>;
    } else {
      // SMS API can send form-encoded
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    }

    // Validate signature if configured
    const config = getConfig();
    if (config.signatureSecret) {
      const sig = req.headers.get("x-vonage-signature");
      if (sig) {
        // Vonage uses HMAC-SHA256 of the JSON body
        const expected = createHmac("sha256", config.signatureSecret)
          .update(JSON.stringify(body))
          .digest("hex");
        if (sig !== expected) return null;
      }
    }

    // Messages API format (JSON with nested objects)
    if (body.from && typeof body.from === "object") {
      const fromObj = body.from as { number?: string };
      const toObj = body.to as { number?: string };
      const msgId = body.message_uuid as string || "";
      const text = (body.text as string) || "";

      const mediaUrls: string[] = [];
      if (body.image && typeof body.image === "object") {
        const img = body.image as { url?: string };
        if (img.url) mediaUrls.push(img.url);
      }

      return {
        from: fromObj.number || "",
        to: toObj?.number || "",
        message: text,
        providerMessageId: msgId,
        mediaUrls,
      };
    }

    // SMS API format (flat params)
    const from = (body.msisdn as string) || (body.from as string) || "";
    const to = (body.to as string) || "";
    const message = (body.text as string) || (body.body as string) || "";
    const messageId = (body.messageId as string) || (body["message-id"] as string) || "";

    if (!from || !messageId) return null;

    return {
      from,
      to,
      message,
      providerMessageId: messageId,
      mediaUrls: [],
    };
  },

  getFromNumber(): string {
    return process.env.VONAGE_PHONE_NUMBER!;
  },

  async fetchMedia(): Promise<string[]> {
    // Vonage includes media URLs in the webhook payload directly
    return [];
  },
};
