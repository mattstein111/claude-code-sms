/**
 * voip.ms REST API client for SMS/MMS operations.
 *
 * All API calls are GET requests with query parameters.
 * Phone numbers must be 11 digits without + prefix.
 */

import { toVoipMs } from "./phone";

interface VoipMsConfig {
  user: string;
  password: string;
  did: string;
}

interface VoipMsResponse {
  status: string;
  [key: string]: unknown;
}

function getConfig(): VoipMsConfig {
  const user = process.env.VOIPMS_USER;
  const password = process.env.VOIPMS_API_PASSWORD;
  const did = process.env.VOIPMS_DID;

  if (!user || !password || !did) {
    throw new Error(
      "Missing voip.ms config. Set VOIPMS_USER, VOIPMS_API_PASSWORD, VOIPMS_DID in .env"
    );
  }

  return { user, password, did };
}

const API_BASE = "https://voip.ms/api/v1/rest.php";

async function apiCall(
  params: Record<string, string>
): Promise<VoipMsResponse> {
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

  const data = (await resp.json()) as VoipMsResponse;
  if (data.status !== "success") {
    throw new Error(`voip.ms API error: ${data.status}`);
  }

  return data;
}

/** Send an SMS message. Returns the API response. */
export async function sendSMS(
  to: string,
  message: string
): Promise<VoipMsResponse> {
  const config = getConfig();
  return apiCall({
    method: "sendSMS",
    did: config.did,
    dst: toVoipMs(to),
    message,
  });
}

/**
 * Send an MMS message with media attachments.
 * Media URLs must be publicly accessible, max 3 URLs, max 1300KB each.
 * Supported: JPG, GIF, PNG, MP3, WAV, MIDI, MP4, 3GP.
 */
export async function sendMMS(
  to: string,
  message: string,
  mediaUrls: string[]
): Promise<VoipMsResponse> {
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

  return apiCall(params);
}

/**
 * Fetch MMS media details by voip.ms message ID.
 * Fallback when the webhook doesn't include media URLs.
 */
export async function getMMS(
  smsId: string
): Promise<VoipMsResponse> {
  return apiCall({
    method: "getMMS",
    id: smsId,
  });
}
