/**
 * Sinch SMS/MMS provider.
 *
 * API: POST-based REST at https://{region}.sms.api.sinch.com/xms/v1/{servicePlanId}/batches
 * Auth: Bearer token (API token)
 * Webhooks: POST with JSON body, optional HMAC-SHA256 signature
 * Phone format: E.164 (+14165551234)
 *
 * Required env vars:
 *   SINCH_SERVICE_PLAN_ID — Sinch service plan ID
 *   SINCH_API_TOKEN       — Sinch API bearer token
 *   SINCH_PHONE_NUMBER    — Sinch virtual number in E.164
 *   SMS_WEBHOOK_TOKEN     — secret token for webhook URL validation
 *
 * Optional:
 *   SINCH_REGION          — API region (default: "us")
 *   SINCH_WEBHOOK_SECRET  — HMAC-SHA256 webhook signing secret (mandatory if set)
 *
 * Webhook signature: When configured, Sinch signs the raw request body with
 * HMAC-SHA256 using the webhook secret. Signature is in x-sinch-webhook-signature
 * header as a hex string.
 *
 * Docs: https://developers.sinch.com/docs/sms/api-reference/
 *       https://developers.sinch.com/docs/sms/api-reference/receiving-sms/
 *
 * Status: UNTESTED — implementation based on Sinch API documentation.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { createHmac } from "crypto";
import { constantTimeEquals } from "../crypto";

function getConfig() {
  return {
    servicePlanId: process.env.SINCH_SERVICE_PLAN_ID!,
    apiToken: process.env.SINCH_API_TOKEN!,
    phoneNumber: process.env.SINCH_PHONE_NUMBER!,
    region: process.env.SINCH_REGION || "us",
    webhookSecret: process.env.SINCH_WEBHOOK_SECRET,
  };
}

function apiBase(region: string, servicePlanId: string): string {
  return `https://${region}.sms.api.sinch.com/xms/v1/${servicePlanId}`;
}

export const sinchProvider: SmsProvider = {
  name: "sinch",
  webhookMethod: "POST",

  validateConfig() {
    const required = ["SINCH_SERVICE_PLAN_ID", "SINCH_API_TOKEN", "SINCH_PHONE_NUMBER"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Sinch: missing env vars: ${missing.join(", ")}`);
    }
    if (!process.env.SINCH_WEBHOOK_SECRET && !process.env.SMS_WEBHOOK_TOKEN) {
      throw new Error(
        "Sinch: at least one of SINCH_WEBHOOK_SECRET or SMS_WEBHOOK_TOKEN must be set for webhook authentication"
      );
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();
    const url = `${apiBase(config.region, config.servicePlanId)}/batches`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.phoneNumber,
        to: [to],
        body: message,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Sinch API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { id: string };
    return { id: data.id };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();
    const url = `${apiBase(config.region, config.servicePlanId)}/batches`;

    // Sinch MMS uses the same batches endpoint with media_body
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.phoneNumber,
        to: [to],
        body: message,
        type: "mt_media",
        parameters: {
          media_body: {
            url: mediaUrls[0],
            message,
          },
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Sinch MMS API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { id: string };
    return { id: data.id };
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

    // Read body once for both signature validation and parsing
    const rawBody = await req.text();

    // HMAC-SHA256 signature validation — MANDATORY when secret is configured
    const config = getConfig();
    if (config.webhookSecret) {
      const signature = req.headers.get("x-sinch-webhook-signature");
      if (!signature) return null; // reject unsigned when secret is configured

      const expected = createHmac("sha256", config.webhookSecret)
        .update(rawBody)
        .digest("hex");
      if (!constantTimeEquals(signature, expected)) return null;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Sinch inbound SMS webhook format
    // type = "mo_text" for inbound SMS
    const type = body.type as string;
    if (type && !type.startsWith("mo_")) return null; // only inbound messages

    const from = (body.from as string) || "";
    const to = (body.to as string) || "";
    const message = (body.body as string) || "";
    const messageId = (body.id as string) || "";

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
    return process.env.SINCH_PHONE_NUMBER!;
  },

  async fetchMedia(): Promise<string[]> {
    return [];
  },
};
