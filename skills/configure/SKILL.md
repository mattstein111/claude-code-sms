---
name: sms:configure
description: Set SMS provider credentials and webhook settings for the SMS channel plugin
user_invocable: true
---

# /sms:configure

Configure the SMS channel plugin credentials and settings.

## What this does

Writes configuration to `~/.claude/channels/sms/.env` (chmod 600). This file is used by both the webhook listener and the MCP server.

## Flow

1. Ensure `~/.claude/channels/sms/` directory exists (create with `mkdir -p` if not)
2. If `.env` already exists, read it and show current values (masked passwords) to the user
3. Ask which SMS provider to use: `voipms`, `twilio`, `vonage`, `telnyx`, or `plivo`
4. Ask for provider-specific settings (see below)
5. Ask for common settings (OWNER_PHONE, SMS_WEBHOOK_TOKEN, etc.)
6. Write the `.env` file with chmod 600
7. Create a default `access.json` if it doesn't exist
8. Remind the user about webhook setup for their provider

## Common settings (all providers)

- **SMS_PROVIDER** — one of: `voipms`, `twilio`, `vonage`, `telnyx`, `plivo`
- **OWNER_PHONE** — the owner's personal phone number in E.164 format (+1XXXXXXXXXX). This number gets full trust and permission relay.
- **SMS_WEBHOOK_TOKEN** — a secret token for webhook URL validation. Generate a random one if the user doesn't have one: `openssl rand -hex 24`
- **SMS_WEBHOOK_PATH** — the URL path for the webhook endpoint (default: `/incoming`). Should be obscured, e.g. `/sms-abc123/incoming`
- **LISTEN_PORT** — port for the webhook listener (default: `5090`)

## Provider-specific settings

### voipms
- **VOIPMS_USER** — voip.ms account email
- **VOIPMS_API_PASSWORD** — voip.ms API password (not the account password — set separately in voip.ms portal under API settings)
- **VOIPMS_DID** — the voip.ms DID (phone number) to send/receive from, 10 or 11 digits
- Webhook: DID → Edit → SMS/MMS → URL Callback. Append `?token=YOUR_TOKEN` to the URL.

### twilio
- **TWILIO_ACCOUNT_SID** — Twilio account SID (starts with AC)
- **TWILIO_AUTH_TOKEN** — Twilio auth token
- **TWILIO_PHONE_NUMBER** — Twilio phone number in E.164
- Webhook: Phone number settings → Messaging → "A MESSAGE COMES IN" URL. Twilio also signs webhooks with X-Twilio-Signature.

### vonage
- **VONAGE_API_KEY** — Vonage API key
- **VONAGE_API_SECRET** — Vonage API secret
- **VONAGE_PHONE_NUMBER** — Vonage virtual number in E.164
- **VONAGE_SIGNATURE_SECRET** — (optional) webhook signature validation secret
- Webhook: Dashboard → Numbers → Your number → Edit → Inbound Webhook URL

### telnyx
- **TELNYX_API_KEY** — Telnyx API v2 key (starts with KEY)
- **TELNYX_PHONE_NUMBER** — Telnyx phone number in E.164
- **TELNYX_PUBLIC_KEY** — (optional) Telnyx webhook public key for signature verification
- **TELNYX_MESSAGING_PROFILE_ID** — (optional) messaging profile ID
- Webhook: Mission Control Portal → Messaging → your number or profile → Inbound Message Webhook

### plivo
- **PLIVO_AUTH_ID** — Plivo auth ID
- **PLIVO_AUTH_TOKEN** — Plivo auth token
- **PLIVO_PHONE_NUMBER** — Plivo phone number in E.164
- **PLIVO_SIGNATURE_V3_TOKEN** — (optional) V3 webhook validation token
- Webhook: Console → Messaging → Applications → Message URL

## Post-configuration reminders

After writing the `.env`, remind the user to:
1. Set up the webhook URL in their provider's portal (provider-specific instructions above)
2. Configure a Cloudflare tunnel (or similar) pointing to the LISTEN_PORT
3. Install and start the systemd service for the webhook listener
4. Add their own phone number to the allowlist if it's different from OWNER_PHONE: `/sms:access allow +1XXXXXXXXXX`
