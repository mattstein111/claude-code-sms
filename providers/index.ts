/**
 * Provider registry — maps SMS_PROVIDER env var to the correct implementation.
 *
 * To add a new provider:
 *   1. Create providers/<name>.ts implementing SmsProvider
 *   2. Import and register it here
 *   3. Document required env vars in README and /sms:configure skill
 */

import type { SmsProvider } from "./interface";
import { voipmsProvider } from "./voipms";
import { twilioProvider } from "./twilio";
import { vonageProvider } from "./vonage";
import { telnyxProvider } from "./telnyx";
import { plivoProvider } from "./plivo";

const providers: Record<string, SmsProvider> = {
  voipms: voipmsProvider,
  twilio: twilioProvider,
  vonage: vonageProvider,
  telnyx: telnyxProvider,
  plivo: plivoProvider,
};

/** All registered provider names. */
export const providerNames = Object.keys(providers);

/**
 * Get the configured provider.
 * Reads SMS_PROVIDER env var, defaults to "voipms".
 * Validates config on first access.
 */
export function getProvider(): SmsProvider {
  const name = (process.env.SMS_PROVIDER || "voipms").toLowerCase();
  const provider = providers[name];

  if (!provider) {
    throw new Error(
      `Unknown SMS provider: "${name}". Supported: ${providerNames.join(", ")}`
    );
  }

  provider.validateConfig();
  return provider;
}

export type { SmsProvider, InboundMessage, SendResult } from "./interface";
