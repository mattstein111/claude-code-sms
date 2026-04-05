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
3. Ask which SMS provider to use: `twilio`, `vonage`, `telnyx`, `plivo`, `messagebird`, `sinch`, or `other`
4. Ask for provider-specific settings (see below)
5. Ask for common settings (OWNER_PHONE, SMS_WEBHOOK_TOKEN, etc.)
6. Write the `.env` file with chmod 600
7. Create a default `access.json` if it doesn't exist
8. Remind the user about webhook setup for their provider

## Common settings (all providers)

- **SMS_PROVIDER** — one of: `twilio`, `vonage`, `telnyx`, `plivo`, `messagebird`, `sinch`, `other`
- **OWNER_PHONE** — the owner's personal phone number in E.164 format (+1XXXXXXXXXX). This number gets full trust and permission relay.

### Optional tuning (have sensible defaults — only ask if user wants to customize):
- **RATE_LIMIT_PER_MINUTE** — max inbound messages per phone per minute (default: 10)
- **RATE_LIMIT_PER_HOUR** — max inbound messages per phone per hour (default: 100)
- **RETENTION_MAX_PER_PHONE** — max messages to keep per counterparty phone (default: 1000)
- **RETENTION_MAX_DAYS** — max age in days for all messages (default: 180, 0 = forever)
- **RETENTION_BLOCKED_DAYS** — days to keep blocked messages (default: 3, 0 = forever)
- **SMS_WEBHOOK_TOKEN** — a secret token for webhook URL validation. Generate a random one if the user doesn't have one: `openssl rand -hex 24`
- **SMS_WEBHOOK_PATH** — the URL path for the webhook endpoint (default: `/incoming`). Should be obscured, e.g. `/sms-abc123/incoming`
- **LISTEN_PORT** — port for the webhook listener (default: `5090`)

## Provider-specific settings

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

### messagebird
- **MESSAGEBIRD_ACCESS_KEY** — MessageBird API access key
- **MESSAGEBIRD_PHONE_NUMBER** — MessageBird virtual number in E.164
- **MESSAGEBIRD_SIGNING_KEY** — (optional) webhook signing key for JWT signature validation
- Webhook: Dashboard → Developers → API Settings → configure webhook URL for inbound messages

### sinch
- **SINCH_SERVICE_PLAN_ID** — Sinch service plan ID
- **SINCH_API_TOKEN** — Sinch API bearer token
- **SINCH_PHONE_NUMBER** — Sinch virtual number in E.164
- **SINCH_REGION** — (optional) API region, default: `us`
- **SINCH_WEBHOOK_SECRET** — (optional) HMAC-SHA256 webhook signing secret
- Webhook: Dashboard → SMS → APIs → configure callback URL for your service plan

### other (generic provider)
- No provider-specific env vars — credentials are referenced via `{{env.VAR}}` in the JSON config
- Guide the user to copy `other-provider.example.json` to `~/.claude/channels/sms/other-provider.json`
- Help them pick the right type preset (`basic_json`, `bearer_json`, `apikey_json`, `basic_form`, `query_get`, `custom`)
- Help them fill in the config fields for their specific provider
- Ensure any env vars referenced in the config are added to `.env`
- Webhook: Provider-specific — guide the user to set the URL with `?token=<SMS_WEBHOOK_TOKEN>` appended

## Post-configuration reminders

After writing the `.env`, remind the user to:
1. Set up the webhook URL in their provider's portal (provider-specific instructions above)
2. Configure a Cloudflare tunnel (or similar) pointing to the LISTEN_PORT
3. Install and start the systemd service for the webhook listener
4. Add their own phone number to the allowlist if it's different from OWNER_PHONE: `/sms:access allow +1XXXXXXXXXX`
