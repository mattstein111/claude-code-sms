/**
 * SMS provider interface.
 *
 * Each provider implements this interface to handle sending messages
 * and parsing inbound webhooks. The listener and MCP server are
 * provider-agnostic — they call these methods without knowing
 * which provider is active.
 *
 * To add a new provider:
 *   1. Create providers/<name>.ts implementing SmsProvider
 *   2. Register it in providers/index.ts
 *   3. Document required env vars in README and /sms:configure skill
 */

/** Parsed inbound message from a webhook. */
export interface InboundMessage {
  /** Sender phone number (raw, will be normalized by caller). */
  from: string;
  /** Destination phone number (raw). */
  to: string;
  /** Message text body. */
  message: string;
  /** Provider-specific message ID for deduplication. */
  providerMessageId: string;
  /** Media/attachment URLs (empty array if SMS, populated if MMS). */
  mediaUrls: string[];
}

/** Result of sending a message. */
export interface SendResult {
  /** Provider-specific message ID. */
  id: string;
}

export interface SmsProvider {
  /** Provider name (e.g. "twilio", "sinch"). */
  readonly name: string;

  /**
   * Validate that all required env vars are set.
   * Throws with a descriptive message if not.
   */
  validateConfig(): void;

  /**
   * Send an SMS (text only).
   * Phone numbers are E.164 format — provider converts as needed.
   */
  sendSMS(to: string, message: string): Promise<SendResult>;

  /**
   * Send an MMS with media attachments.
   * Media URLs must be publicly accessible.
   * Phone numbers are E.164 format.
   */
  sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult>;

  /**
   * Parse and validate an inbound webhook request.
   * Returns null if the request is invalid (bad auth, wrong format, etc.).
   * The listener calls this for every incoming HTTP request on the webhook path.
   */
  parseWebhook(req: Request): Promise<InboundMessage | null>;

  /**
   * Fetch MMS media for a message by provider message ID.
   * Returns media URLs. Used as a fallback when the webhook
   * doesn't include media directly.
   * Return empty array if not supported or no media found.
   */
  fetchMedia(providerMessageId: string): Promise<string[]>;

  /**
   * HTTP method(s) the provider uses for webhooks.
   * voip.ms uses GET, most others use POST.
   */
  readonly webhookMethod: "GET" | "POST" | "GET|POST";

  /**
   * Get the local phone number (DID) this provider sends from.
   * Returns E.164 format. Used to record which number sent outbound messages.
   */
  getFromNumber(): string;
}
