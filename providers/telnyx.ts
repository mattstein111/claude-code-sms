/**
 * Telnyx SMS/MMS provider.
 *
 * API: POST-based REST at https://api.telnyx.com/v2/messages
 * Auth: Bearer token (API key)
 * Webhooks: POST with JSON body, signed with ed25519 public key
 * Phone format: E.164 (+14165551234)
 *
 * Required env vars:
 *   TELNYX_API_KEY          — Telnyx API v2 key (starts with KEY...)
 *   TELNYX_PHONE_NUMBER     — Telnyx phone number in E.164
 *   TELNYX_PUBLIC_KEY       — Telnyx webhook public key (MANDATORY for signature validation)
 *   SMS_WEBHOOK_TOKEN       — optional extra token for webhook URL validation
 *
 * Optional:
 *   TELNYX_MESSAGING_PROFILE_ID — messaging profile ID (if using profiles)
 *
 * Docs: https://developers.telnyx.com/docs/messaging/messages
 *
 * Status: UNTESTED — implementation based on Telnyx API documentation.
 *         See GitHub issue for testing status.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { verify } from "crypto";
import { constantTimeEquals } from "../crypto";

const API_BASE = "https://api.telnyx.com/v2/messages";

function getConfig() {
  return {
    apiKey: process.env.TELNYX_API_KEY!,
    phoneNumber: process.env.TELNYX_PHONE_NUMBER!,
    publicKey: process.env.TELNYX_PUBLIC_KEY,
    messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
  };
}

/**
 * Verify Telnyx webhook ed25519 signature.
 * https://developers.telnyx.com/docs/api/v2/overview#webhook-signing
 *
 * Telnyx signs `timestamp|body` with an ed25519 private key.
 * The public key is available in the Telnyx portal.
 */
function verifyTelnyxSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string
): boolean {
  try {
    const signedPayload = `${timestamp}|${body}`;
    return verify(
      null,
      Buffer.from(signedPayload),
      { key: publicKey, format: "pem" },
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

export const telnyxProvider: SmsProvider = {
  name: "telnyx",
  webhookMethod: "POST",

  validateConfig() {
    const required = ["TELNYX_API_KEY", "TELNYX_PHONE_NUMBER"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Telnyx: missing env vars: ${missing.join(", ")}`);
    }
    if (!process.env.TELNYX_PUBLIC_KEY && !process.env.SMS_WEBHOOK_TOKEN) {
      throw new Error(
        "Telnyx: at least one of TELNYX_PUBLIC_KEY or SMS_WEBHOOK_TOKEN must be set for webhook authentication"
      );
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();

    const payload: Record<string, unknown> = {
      from: config.phoneNumber,
      to: to,
      text: message,
      type: "SMS",
    };
    if (config.messagingProfileId) {
      payload.messaging_profile_id = config.messagingProfileId;
    }

    const resp = await fetch(API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Telnyx API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { data: { id: string } };
    return { id: data.data.id };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();

    const payload: Record<string, unknown> = {
      from: config.phoneNumber,
      to: to,
      text: message,
      type: "MMS",
      media_urls: mediaUrls,
    };
    if (config.messagingProfileId) {
      payload.messaging_profile_id = config.messagingProfileId;
    }

    const resp = await fetch(API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Telnyx API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { data: { id: string } };
    return { id: data.data.id };
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

    // Read body once
    const rawBody = await req.text();

    // ed25519 signature validation — MANDATORY when public key is configured
    const config = getConfig();
    if (config.publicKey) {
      const signature = req.headers.get("telnyx-signature-ed25519");
      const timestamp = req.headers.get("telnyx-timestamp");
      if (!signature || !timestamp) return null; // reject unsigned

      // Replay protection — reject webhooks older than 5 minutes
      const webhookAge = Date.now() / 1000 - Number(timestamp);
      if (isNaN(webhookAge) || Math.abs(webhookAge) > 300) return null;

      if (!verifyTelnyxSignature(config.publicKey, signature, timestamp, rawBody)) {
        return null;
      }
    }

    let body: {
      data?: {
        event_type?: string;
        payload?: {
          id?: string;
          from?: { phone_number?: string };
          to?: Array<{ phone_number?: string }>;
          text?: string;
          media?: Array<{ url?: string }>;
        };
      };
    };

    try {
      body = JSON.parse(rawBody);
    } catch {
      return null; // malformed JSON
    }

    const payload = body.data?.payload;
    if (!payload) return null;

    const eventType = body.data?.event_type;
    if (eventType && !eventType.includes("message.received")) return null;

    const from = payload.from?.phone_number || "";
    const to = payload.to?.[0]?.phone_number || "";
    const message = payload.text || "";
    const messageId = payload.id || "";

    if (!from || !messageId) return null;

    const mediaUrls: string[] = [];
    if (payload.media) {
      for (const m of payload.media) {
        if (m.url) mediaUrls.push(m.url);
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
    return process.env.TELNYX_PHONE_NUMBER!;
  },

  async fetchMedia(): Promise<string[]> {
    return [];
  },
};
