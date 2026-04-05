---
name: sms:configure
description: Set voip.ms credentials and webhook settings for the SMS channel plugin
user_invocable: true
---

# /sms:configure

Configure the SMS channel plugin credentials and settings.

## What this does

Writes configuration to `~/.claude/channels/sms/.env` (chmod 600). This file is used by both the webhook listener and the MCP server.

## Required settings

Ask the user for each of these if not provided:

1. **VOIPMS_USER** — voip.ms account email
2. **VOIPMS_API_PASSWORD** — voip.ms API password (not the account password — set separately in voip.ms portal under API settings)
3. **VOIPMS_DID** — the voip.ms DID (phone number) to send/receive from, 10 or 11 digits
4. **OWNER_PHONE** — the owner's personal phone number in E.164 format (+1XXXXXXXXXX). This number gets full trust and permission relay.
5. **SMS_WEBHOOK_TOKEN** — a secret token for webhook validation. Generate a random one if the user doesn't have one: `openssl rand -hex 24`
6. **SMS_WEBHOOK_PATH** — the URL path for the webhook endpoint (default: `/incoming`). Should be obscured, e.g. `/sms-abc123/incoming`
7. **LISTEN_PORT** — port for the webhook listener (default: `5090`)

## Steps

1. Ensure `~/.claude/channels/sms/` directory exists (create with `mkdir -p` if not)
2. If `.env` already exists, read it and show current values (masked passwords) to the user
3. Ask for any values that need to change
4. Write the `.env` file with chmod 600
5. Create a default `access.json` if it doesn't exist:
   ```json
   {
     "dmPolicy": "allowlist",
     "allowFrom": [],
     "blockList": [],
     "textChunkLimit": 160,
     "chunkMode": "length"
   }
   ```
6. Remind the user to:
   - Set up the voip.ms webhook URL in their voip.ms portal (DID → Edit → SMS/MMS → URL Callback)
   - Configure a Cloudflare tunnel pointing to the LISTEN_PORT
   - Install and start the systemd service for the webhook listener
