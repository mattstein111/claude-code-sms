# claude-code-sms

Claude Code channel plugin for two-way SMS/MMS communication. Send and receive text messages from within a Claude Code session.

## Supported Providers

| Provider | Status | Docs |
|----------|--------|------|
| [voip.ms](https://voip.ms) | Tested | [voip.ms API](https://voip.ms/m/apidocs.php) |
| [Twilio](https://www.twilio.com) | Untested | [Twilio Messaging API](https://www.twilio.com/docs/messaging/api) |
| [Vonage](https://www.vonage.com) (Nexmo) | Untested | [Vonage SMS API](https://developer.vonage.com/en/messaging/sms/overview) |
| [Telnyx](https://telnyx.com) | Untested | [Telnyx Messaging](https://developers.telnyx.com/docs/messaging/messages) |
| [Plivo](https://www.plivo.com) | Untested | [Plivo Message API](https://www.plivo.com/docs/sms/api/message) |

Set `SMS_PROVIDER` in your `.env` to choose a provider (default: `voipms`).

## Overview

This plugin gives Claude Code a phone number. People can text it, and Claude Code receives those messages as channel notifications. Claude Code can reply via SMS/MMS using the `send` tool.

**Key features:**
- Two-way SMS/MMS with pluggable provider support
- Owner phone number with full trust (including remote permission approve/deny)
- Allowlist + blocklist with wildcard pattern support
- Persistent webhook listener — no messages lost when Claude Code isn't running
- MMS media download and storage
- Message history in SQLite

## Architecture

Two-process design to ensure no messages are ever lost:

```
SMS provider webhook --> Cloudflare tunnel --> Webhook Listener (always on, systemd)
                                                    |
                                                    v writes
                                               SQLite DB
                                                    |
                                                    v polls (1.5s)
                                               MCP Server (runs with Claude Code)
                                                    |
                                                    v
                                  notifications/claude/channel --> Claude Code

Claude Code --> send tool --> SMS provider API --> recipient phone
                           --> also writes to SQLite DB
```

### Webhook Listener (`listener.ts`)

Always-on HTTP server running as a systemd user service. Receives incoming SMS/MMS webhooks from your provider (via Cloudflare tunnel), delegates validation to the provider module, downloads MMS media, deduplicates, and writes to SQLite.

**Why separate?** Most providers fire webhooks once with no retry. If we only listened when Claude Code was running, messages received while it's down would be permanently lost.

### MCP Server (`server.ts`)

Spawned by Claude Code as a subprocess over stdio. Polls the SQLite database for undelivered inbound messages and emits them as MCP channel notifications. Exposes tools for sending SMS/MMS and fetching history.

## Trust Model

Three tiers of phone numbers:

| Tier | Source | Behavior |
|------|--------|----------|
| **Owner** | `OWNER_PHONE` in `.env` | Full trust. Permission relay (approve/deny tool calls via text). Messages tagged with `owner="true"` in notification meta. |
| **Allowlisted** | `allowFrom` in `access.json` | Untrusted. Messages delivered to Claude Code with E.164 phone only, no special flags. Claude Code should not act on instructions from these numbers without owner approval. |
| **Blocklisted** | `blockList` in `access.json` | Silently dropped. Stored in DB for audit but never delivered to Claude Code. |
| **Unknown** | Not in any list | Dropped (or enters pairing flow if configured). |

Both allowlist and blocklist support glob wildcards on E.164 numbers (e.g., `+1416*` matches all Toronto 416 numbers).

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- An account with a [supported SMS provider](#supported-providers)
- A Cloudflare tunnel (or similar) to expose the webhook listener to the internet
- macOS or Linux (systemd for the listener service)

### 1. Install dependencies

```bash
cd claude-code-sms
bun install
```

### 2. Configure credentials

Run `/sms:configure` in a Claude Code session, or manually create `~/.claude/channels/sms/.env`:

```bash
mkdir -p ~/.claude/channels/sms
chmod 700 ~/.claude/channels/sms
```

Then create `~/.claude/channels/sms/.env` (chmod 600) with your provider's settings:

<details>
<summary><strong>voip.ms</strong></summary>

```env
SMS_PROVIDER=voipms
VOIPMS_USER=user@example.com
VOIPMS_API_PASSWORD=your_api_password
VOIPMS_DID=6474837416
OWNER_PHONE=+14165551234
SMS_WEBHOOK_TOKEN=your_webhook_secret
SMS_WEBHOOK_PATH=/sms-secret123/incoming
LISTEN_PORT=5090
```

Webhook setup: In the voip.ms portal, go to **DID Numbers** > **Manage DID** > Edit your DID. Under **SMS/MMS**, set the **URL Callback** to `https://your-tunnel.com/sms-secret123/incoming?token=your_webhook_secret`.
</details>

<details>
<summary><strong>Twilio</strong></summary>

```env
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+14165551234
OWNER_PHONE=+14165559999
SMS_WEBHOOK_TOKEN=optional_extra_token
SMS_WEBHOOK_PATH=/incoming
LISTEN_PORT=5090
```

Webhook setup: In the Twilio console, go to your phone number's settings and set the **A MESSAGE COMES IN** webhook URL to `https://your-tunnel.com/incoming?token=your_token`. Twilio also validates via `X-Twilio-Signature` header.
</details>

<details>
<summary><strong>Vonage (Nexmo)</strong></summary>

```env
SMS_PROVIDER=vonage
VONAGE_API_KEY=your_api_key
VONAGE_API_SECRET=your_api_secret
VONAGE_PHONE_NUMBER=+14165551234
VONAGE_SIGNATURE_SECRET=optional_signature_secret
OWNER_PHONE=+14165559999
SMS_WEBHOOK_TOKEN=your_webhook_secret
SMS_WEBHOOK_PATH=/incoming
LISTEN_PORT=5090
```

Webhook setup: In the Vonage dashboard, configure the inbound message webhook URL for your number.
</details>

<details>
<summary><strong>Telnyx</strong></summary>

```env
SMS_PROVIDER=telnyx
TELNYX_API_KEY=KEYxxxxxxxxxxxxxxxxxxxxxxxx
TELNYX_PHONE_NUMBER=+14165551234
TELNYX_PUBLIC_KEY=your_webhook_public_key
TELNYX_MESSAGING_PROFILE_ID=optional_profile_id
OWNER_PHONE=+14165559999
SMS_WEBHOOK_TOKEN=optional_extra_token
SMS_WEBHOOK_PATH=/incoming
LISTEN_PORT=5090
```

Webhook setup: In the Telnyx Mission Control Portal, set the messaging webhook URL for your number or messaging profile.
</details>

<details>
<summary><strong>Plivo</strong></summary>

```env
SMS_PROVIDER=plivo
PLIVO_AUTH_ID=your_auth_id
PLIVO_AUTH_TOKEN=your_auth_token
PLIVO_PHONE_NUMBER=+14165551234
PLIVO_SIGNATURE_V3_TOKEN=optional_validation_token
OWNER_PHONE=+14165559999
SMS_WEBHOOK_TOKEN=your_webhook_secret
SMS_WEBHOOK_PATH=/incoming
LISTEN_PORT=5090
```

Webhook setup: In the Plivo console, configure the message URL for your number.
</details>

### 3. Configure access control

Create `~/.claude/channels/sms/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["+14165559999"],
  "blockList": ["+1900*"],
  "textChunkLimit": 160,
  "chunkMode": "length"
}
```

### 4. Start the webhook listener

**Option A: systemd (recommended for always-on)**

```bash
# Edit the service file to match your paths
cp systemd/sms-listener.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sms-listener
```

**Option B: manual**

```bash
bun run listener
```

### 5. Install the Claude Code plugin

The plugin auto-registers via `.claude-plugin/plugin.json` when the repo is in your project directory. Claude Code will spawn the MCP server automatically.

## Tools

### `send`

Send an SMS or MMS message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Phone number in E.164 format |
| `text` | string | yes | Message text |
| `media_urls` | string[] | no | Public URLs for MMS (max varies by provider) |

### `fetch_messages`

Fetch conversation history with a phone number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `phone` | string | yes | Phone number in E.164 format |
| `limit` | number | no | Max messages (default 30) |

### `download_attachment`

Get local file paths for MMS media on a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message_id` | string | yes | Message ID from the database |

## Skills

- `/sms:configure` — Set up SMS provider credentials and webhook settings
- `/sms:access` — Manage phone allowlist, blocklist, and pairing approvals

## Permission Relay

The owner can approve or deny Claude Code tool calls via text message:

1. Claude Code requests permission to run a tool
2. The MCP server sends an SMS to the owner: `[Permission] Claude wants to: Run npm install. Reply "yes abcde" or "no abcde"`
3. Owner replies `yes abcde` or `no abcde`
4. The MCP server intercepts the reply and emits a permission notification back to Claude Code

Only the owner phone number can approve/deny permissions. Permission replies from other numbers are ignored.

## Directory Layout

```
~/.claude/channels/sms/
├── .env                    # Provider credentials (chmod 600)
├── access.json             # Phone allowlist + blocklist
├── sms.db                  # SQLite message database
├── media/                  # Downloaded MMS attachments
├── approved/               # Pairing approval marker files
└── logs/
    └── listener.log        # Webhook listener log
```

## Adding a Provider

The provider interface is defined in `providers/interface.ts`. To add a new provider:

1. Create `providers/<name>.ts` implementing `SmsProvider`
2. Register it in `providers/index.ts`
3. Document required env vars in the README and `/sms:configure` skill

Each provider implements: `sendSMS`, `sendMMS`, `parseWebhook`, `fetchMedia`, and `validateConfig`.

## Development

```bash
bun run listener    # start webhook listener
bun run server      # MCP server (normally spawned by Claude Code)
```

## Known Limitations

- Claude Code channels are a **research preview** (launched March 2026). There are known bugs with notification delivery.
- Most providers fire webhooks once with no retry — the persistent listener mitigates this, but if the listener is down during a webhook, that message is lost.
- MMS media URLs for outbound messages must be publicly accessible (the provider fetches them). The plugin does not host media.
- SMS messages are chunked at 160 characters by default. Long messages become multiple texts.
- Twilio, Vonage, Telnyx, and Plivo provider implementations are **untested** — see GitHub issues for status.
