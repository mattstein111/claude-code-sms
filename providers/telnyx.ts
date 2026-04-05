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
 *   TELNYX_PUBLIC_KEY       — Telnyx webhook public key (for signature validation)
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

const API_BASE = "https://api.telnyx.com/v2/messages";

function getConfig() {
  return {
    apiKey: process.env.TELNYX_API_KEY!,
    phoneNumber: process.env.TELNYX_PHONE_NUMBER!,
    publicKey: process.env.TELNYX_PUBLIC_KEY,
    messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
  };
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

    // Check optional token in query string
    const webhookToken = process.env.SMS_WEBHOOK_TOKEN;
    if (webhookToken) {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (token !== webhookToken) return null;
    }

    // Telnyx webhook signature validation uses ed25519
    // The public key is available in the Telnyx portal
    // Full validation requires the telnyx package — for now, rely on
    // the webhook token and/or Cloudflare tunnel for security
    const config = getConfig();
    if (config.publicKey) {
      const signature = req.headers.get("telnyx-signature-ed25519");
      const timestamp = req.headers.get("telnyx-timestamp");
      if (!signature || !timestamp) {
        // Signature headers missing — if public key is configured, reject
        return null;
      }
      // Note: Full ed25519 verification would require importing the public key
      // and verifying the signature over `timestamp|body`. For now, we check
      // that the headers are present when a public key is configured.
      // TODO: Implement full ed25519 verification
    }

    const body = (await req.json()) as {
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

    const payload = body.data?.payload;
    if (!payload) return null;

    // Only process inbound messages
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

  async fetchMedia(): Promise<string[]> {
    // Telnyx includes media URLs in the webhook payload
    return [];
  },
};
