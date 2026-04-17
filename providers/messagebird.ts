/**
 * MessageBird (Bird) SMS/MMS provider.
 *
 * API: POST-based REST at https://rest.messagebird.com/messages
 * Auth: AccessKey header (Authorization: AccessKey <key>)
 * Webhooks: POST with form-encoded or JSON body, signed with HMAC-SHA256 JWT
 * Phone format: E.164 (+14165551234)
 *
 * Required env vars:
 *   MESSAGEBIRD_ACCESS_KEY   — MessageBird API access key
 *   MESSAGEBIRD_PHONE_NUMBER — MessageBird virtual number in E.164
 *   SMS_WEBHOOK_TOKEN        — secret token for webhook URL validation
 *
 * Optional:
 *   MESSAGEBIRD_SIGNING_KEY — webhook signing key (mandatory for JWT signature validation if set)
 *
 * Webhook signature: MessageBird uses a JWT in the MessageBird-Signature-JWT header,
 * signed with HMAC-SHA256 using the signing key. The JWT payload contains a hash of
 * the request body for integrity verification.
 *
 * Docs: https://developers.messagebird.com/api/sms-messaging/
 *       https://developers.messagebird.com/api/webhooks/#security
 *
 * Status: UNTESTED — implementation based on MessageBird API documentation.
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { createHmac } from "crypto";
import { constantTimeEquals } from "../crypto";

const API_BASE = "https://rest.messagebird.com";

function getConfig() {
  return {
    accessKey: process.env.MESSAGEBIRD_ACCESS_KEY!,
    phoneNumber: process.env.MESSAGEBIRD_PHONE_NUMBER!,
    signingKey: process.env.MESSAGEBIRD_SIGNING_KEY,
  };
}

/**
 * Validate MessageBird webhook JWT signature.
 *
 * The JWT is in the MessageBird-Signature-JWT header, structured as:
 *   header.payload.signature  (standard JWT, HMAC-SHA256)
 *
 * The payload contains:
 *   - url_hash: SHA256 of the webhook URL
 *   - payload_hash: SHA256 of the request body
 *   - jti: unique token ID
 *   - nbf/exp/iat: timing claims
 *
 * We verify the signature and check the payload hash matches the body.
 */
function validateJwtSignature(
  signingKey: string,
  jwt: string,
  body: string
): boolean {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify HMAC-SHA256 signature over header.payload
    const data = `${headerB64}.${payloadB64}`;
    const expected = createHmac("sha256", signingKey).update(data).digest();

    // JWT uses base64url encoding
    const signature = Buffer.from(
      signatureB64.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );

    if (expected.length !== signature.length) return false;
    // Constant-time comparison of raw buffers
    const { timingSafeEqual } = require("crypto");
    if (!timingSafeEqual(expected, signature)) return false;

    // Verify payload hash matches body
    const payload = JSON.parse(
      Buffer.from(
        payloadB64.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf-8")
    ) as { payload_hash?: string; exp?: number };

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;

    // Verify body hash
    if (payload.payload_hash) {
      const bodyHash = createHmac("sha256", signingKey)
        .update(body)
        .digest("hex");
      if (!constantTimeEquals(payload.payload_hash, bodyHash)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export const messagebirdProvider: SmsProvider = {
  name: "messagebird",
  webhookMethod: "POST",
  longMessage: { strategy: "passthrough" },

  validateConfig() {
    const required = ["MESSAGEBIRD_ACCESS_KEY", "MESSAGEBIRD_PHONE_NUMBER"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`MessageBird: missing env vars: ${missing.join(", ")}`);
    }
    if (!process.env.MESSAGEBIRD_SIGNING_KEY && !process.env.SMS_WEBHOOK_TOKEN) {
      throw new Error(
        "MessageBird: at least one of MESSAGEBIRD_SIGNING_KEY or SMS_WEBHOOK_TOKEN must be set for webhook authentication"
      );
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();

    const resp = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: {
        Authorization: `AccessKey ${config.accessKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        originator: config.phoneNumber,
        recipients: [to],
        body: message,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`MessageBird API HTTP ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as { id: string };
    return { id: data.id };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();

    // MessageBird MMS uses the same endpoint with mediaUrls field
    const resp = await fetch(`${API_BASE}/mms`, {
      method: "POST",
      headers: {
        Authorization: `AccessKey ${config.accessKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        originator: config.phoneNumber,
        recipients: [to],
        body: message,
        mediaUrls,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`MessageBird MMS API HTTP ${resp.status}: ${err}`);
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

    // JWT signature validation — MANDATORY when signing key is configured
    const config = getConfig();
    if (config.signingKey) {
      const jwt = req.headers.get("messagebird-signature-jwt");
      if (!jwt) return null; // reject unsigned when key is configured

      if (!validateJwtSignature(config.signingKey, jwt, rawBody)) {
        return null;
      }
    }

    const contentType = req.headers.get("content-type") || "";
    let body: Record<string, unknown>;

    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else {
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }

    const from = (body.originator as string) || (body.from as string) || "";
    const to = (body.recipient as string) || (body.to as string) || "";
    const message = (body.body as string) || (body.message as string) || "";
    const messageId = (body.id as string) || "";

    if (!from || !messageId) return null;

    // Media extraction — check for mediaURLs array in webhook payload
    const mediaUrls: string[] = [];
    if (Array.isArray(body.mediaURLs)) {
      for (const url of body.mediaURLs) {
        if (typeof url === "string") mediaUrls.push(url);
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
    return process.env.MESSAGEBIRD_PHONE_NUMBER!;
  },

  async fetchMedia(): Promise<string[]> {
    return [];
  },
};
