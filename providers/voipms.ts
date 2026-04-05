/**
 * voip.ms SMS/MMS provider.
 *
 * API: GET-based REST at https://voip.ms/api/v1/rest.php
 * Auth: api_username + api_password as query params
 * Webhooks: GET requests with query params (to, from, message, id, media, token)
 * Phone format: 11 digits without + prefix (e.g. 14165551234)
 *
 * Required env vars:
 *   VOIPMS_USER        — voip.ms account email
 *   VOIPMS_API_PASSWORD — voip.ms API password (not account password)
 *   VOIPMS_DID          — DID phone number (10 or 11 digits)
 *   SMS_WEBHOOK_TOKEN   — secret token for webhook validation
 *
 * Docs: https://voip.ms/m/apidocs.php
 *
 * Status: TESTED
 */

import type { SmsProvider, InboundMessage, SendResult } from "./interface";
import { constantTimeEquals } from "../crypto";

const API_BASE = "https://voip.ms/api/v1/rest.php";

function toVoipMs(e164: string): string {
  return e164.replace("+", "");
}

function getConfig() {
  return {
    user: process.env.VOIPMS_USER!,
    password: process.env.VOIPMS_API_PASSWORD!,
    did: process.env.VOIPMS_DID!,
    webhookToken: process.env.SMS_WEBHOOK_TOKEN!,
  };
}

async function apiCall(params: Record<string, string>): Promise<Record<string, unknown>> {
  const config = getConfig();
  const url = new URL(API_BASE);
  url.searchParams.set("api_username", config.user);
  url.searchParams.set("api_password", config.password);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`voip.ms API HTTP ${resp.status}: ${resp.statusText}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  if (data.status !== "success") {
    throw new Error(`voip.ms API error: ${data.status}`);
  }

  return data;
}

export const voipmsProvider: SmsProvider = {
  name: "voipms",
  webhookMethod: "GET",

  validateConfig() {
    const required = ["VOIPMS_USER", "VOIPMS_API_PASSWORD", "VOIPMS_DID", "SMS_WEBHOOK_TOKEN"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`voip.ms: missing env vars: ${missing.join(", ")}`);
    }
  },

  async sendSMS(to: string, message: string): Promise<SendResult> {
    const config = getConfig();
    const data = await apiCall({
      method: "sendSMS",
      did: config.did,
      dst: toVoipMs(to),
      message,
    });
    return { id: String(data.sms ?? "") };
  },

  async sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult> {
    const config = getConfig();
    if (mediaUrls.length > 3) {
      throw new Error("voip.ms supports max 3 media URLs per MMS");
    }

    const params: Record<string, string> = {
      method: "sendMMS",
      did: config.did,
      dst: toVoipMs(to),
      message,
    };
    mediaUrls.forEach((url, i) => {
      params[`media${i + 1}`] = url;
    });

    const data = await apiCall(params);
    return { id: String(data.sms ?? "") };
  },

  async parseWebhook(req: Request): Promise<InboundMessage | null> {
    const url = new URL(req.url);
    const config = getConfig();

    // Validate token (constant-time comparison)
    const token = url.searchParams.get("token");
    if (!constantTimeEquals(token, config.webhookToken)) {
      return null;
    }

    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const message = decodeURIComponent(url.searchParams.get("message") || "");
    const id = url.searchParams.get("id") || "";
    const mediaParam = url.searchParams.get("media") || "";

    if (!from || !id) return null;

    return {
      from,
      to,
      message,
      providerMessageId: id,
      mediaUrls: mediaParam ? mediaParam.split(",").filter(Boolean) : [],
    };
  },

  getFromNumber(): string {
    const did = process.env.VOIPMS_DID!;
    // voip.ms DID is 10-11 digits, normalize to E.164
    const digits = did.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
    return `+${digits}`;
  },

  async fetchMedia(providerMessageId: string): Promise<string[]> {
    try {
      const data = await apiCall({ method: "getMMS", id: providerMessageId });
      const media = data.media as string | undefined;
      if (media) {
        return media.split(",").filter(Boolean);
      }
    } catch {
      // Fallback failed — not all messages are MMS
    }
    return [];
  },
};
