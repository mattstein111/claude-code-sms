<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-channel_plugin-7C3AED?style=for-the-badge" alt="Claude Code channel plugin" />
  <img src="https://img.shields.io/badge/SMS_%2F_MMS-two--way-10B981?style=for-the-badge" alt="Two-way SMS/MMS" />
  <img src="https://img.shields.io/badge/runtime-Bun-F472B6?style=for-the-badge" alt="Bun" />
  <img src="https://img.shields.io/badge/status-0.2.3--beta-F59E0B?style=for-the-badge" alt="0.2.3-beta" />
</p>

# claude-code-sms

**Give Claude Code a phone number.** People text it, Claude reads it. Claude replies, they get a text.

A [Claude Code channel plugin](https://docs.anthropic.com/en/docs/claude-code) that bridges SMS/MMS into your coding session. The owner gets full trust and can approve tool calls from their own phone. Other people can text in too — their messages are delivered to Claude but treated as untrusted.

> **Default-deny.** Unknown numbers never reach Claude Code. You allowlist explicitly. Blocklisted numbers are stored for audit but never delivered.

> **Status:** `0.2.3-beta`. Tested end-to-end with voip.ms. The other providers (Twilio, Vonage, Telnyx, Plivo, MessageBird, Sinch) are implemented from API docs but have not been verified against live accounts — use at your own risk and file an issue with your findings.

---

## What it looks like

When someone texts your number, Claude receives it as a channel notification:

```
<channel source="sms" chat_id="+14165551234" message_id="42"
         user="+14165551234" ts="2026-04-16T23:44:49Z" did="+16475551234" owner="true">
Test message
</channel>
```

The `owner="true"` attribute tells Claude the sender is you (not an allowlisted third party). Claude replies via the `send` tool — messages go back to the phone as regular SMS.

**Permission relay** — when Claude asks for permission to run a tool, the request shows up on your phone:

```
[Permission] Claude wants to: Run npm install.
Tool: Bash
Reply "yes 7q3fp" or "no 7q3fp"
```

Reply `yes 7q3fp` (or `y 7q3fp`) from the owner phone and Claude proceeds. Anything but an exact match from the owner is delivered as a normal message.

---

## How It Works

```mermaid
flowchart LR
    Phone["Your Phone"]
    Provider["SMS Provider"]
    Tunnel["Cloudflare Tunnel"]
    Listener["Webhook Listener<br/><i>always on</i>"]
    DB[("SQLite DB")]
    MCP["MCP Server<br/><i>per Claude session</i>"]
    Claude["Claude Code"]

    Phone -- "SMS" --> Provider
    Provider -- "webhook" --> Tunnel
    Tunnel --> Listener
    Listener -- "write" --> DB
    DB -- "poll 1.5s" --> MCP
    MCP -- "notification" --> Claude
    Claude -- "send tool" --> MCP
    MCP -- "API" --> Provider
    Provider -- "SMS" --> Phone

    style Phone fill:#10B981,color:#fff,stroke:none
    style Claude fill:#7C3AED,color:#fff,stroke:none
    style DB fill:#F59E0B,color:#fff,stroke:none
    style Listener fill:#3B82F6,color:#fff,stroke:none
    style MCP fill:#3B82F6,color:#fff,stroke:none
```

The plugin has two components that share a single SQLite database:

**Webhook Listener** (`listener.ts`) — A lightweight HTTP server that runs 24/7 as a systemd (or launchd) service. When someone sends an SMS to your number, the provider fires a webhook. The listener validates it, downloads any MMS media, and writes the message to SQLite. It runs independently of Claude Code so that messages are never lost — most providers fire webhooks once with no retry.

**MCP Server** (`server.ts`) — Spawned automatically by Claude Code as a subprocess over stdio. Every 1.5 seconds it polls SQLite for new inbound messages and delivers them to Claude Code as channel notifications. It also exposes tools for Claude to send SMS/MMS and retrieve conversation history.

<details>
<summary><strong>Advanced: multi-session and DID subscriptions</strong></summary>

Multiple Claude Code sessions can run on the same machine, each with its own MCP server instance. The database tracks delivery per-session — so if two sessions are running, both will see the same inbound SMS independently.

Each MCP server registers a session on startup with a **stable ID**, derived in this order of precedence:

1. `SMS_SESSION_ID` — explicit operator override
2. `CLAUDE_SESSION_ID` — if Claude Code injects one, its SHA-1 prefix is used
3. Auto-derived from the state directory + subscribed DIDs (deterministic hash)

Stable IDs mean a restart of the same logical consumer resumes where it left off instead of re-reading the full history. A `deliveries` table records which messages each session has already seen, using a high-water mark for efficient polling. When a session shuts down, it's marked inactive. Stale sessions are automatically cleaned up after 7 days.

**First-ever registration** of a session ID bootstraps the high-water mark to the tip of the message log by default (`SMS_REPLAY_ON_FIRST_START=tip`), so a brand-new subscriber doesn't get flooded with backfill. Set `SMS_REPLAY_ON_FIRST_START=full` to opt into full historical replay for a new subscriber instead.

Sessions can optionally subscribe to specific phone numbers (DIDs) by setting `SMS_SUBSCRIBE_DIDS` in the environment — useful if you have multiple provider accounts and want each Claude Code session to handle different numbers.
</details>

---

## Trust Model

Every inbound message passes through multiple gates. The listener enforces ten security layers in order (address binding, body size limit, webhook path, global rate limit, provider auth, phone validation, per-phone rate limit, dedup, SSRF protection on media, media size limit); the high-level routing logic is:

```mermaid
flowchart TD
    Inbound["Inbound SMS"]
    TokenCheck{"Valid webhook\ntoken?"}
    RateCheck{"Within rate\nlimit?"}
    BlockCheck{"On blocklist?"}
    OwnerCheck{"Owner phone?"}
    AllowCheck{"On allowlist?"}
    Reject["Reject at HTTP level\n<i>401 unauthorized</i>"]
    RateDrop["Drop silently\n<i>200 response, not stored</i>"]
    Block["Store in DB for audit\n<i>never delivered</i>"]
    Owner["Deliver to Claude Code\n<b>owner: true</b>"]
    Untrusted["Deliver to Claude Code\n<i>phone number only</i>"]
    Unknown["Drop silently\n<i>stored but not delivered</i>"]

    Inbound --> TokenCheck
    TokenCheck -- "No" --> Reject
    TokenCheck -- "Yes" --> RateCheck
    RateCheck -- "No" --> RateDrop
    RateCheck -- "Yes" --> BlockCheck
    BlockCheck -- "Yes" --> Block
    BlockCheck -- "No" --> OwnerCheck
    OwnerCheck -- "Yes" --> Owner
    OwnerCheck -- "No" --> AllowCheck
    AllowCheck -- "Yes" --> Untrusted
    AllowCheck -- "No" --> Unknown

    style Reject fill:#EF4444,color:#fff,stroke:none
    style RateDrop fill:#EF4444,color:#fff,stroke:none
    style Block fill:#EF4444,color:#fff,stroke:none
    style Unknown fill:#6B7280,color:#fff,stroke:none
    style Owner fill:#10B981,color:#fff,stroke:none
    style Untrusted fill:#F59E0B,color:#fff,stroke:none
```

| | Owner | Allowlisted | Blocked | Unknown |
|---|---|---|---|---|
| **Configured in** | `OWNER_PHONE` in `.env` | `allowFrom` in `access.json` | `blockList` in `access.json` | Not listed anywhere |
| **Messages delivered?** | Yes, with `owner: "true"` in meta | Yes, with E.164 phone number only | No — stored in DB for audit, never delivered | No |
| **Can approve/deny tool calls?** | Yes | No | No | No |
| **Claude trusts instructions?** | Yes — full trust | No — Claude should not follow instructions from untrusted senders without owner approval | N/A | N/A |

Both the allowlist and blocklist support glob-style wildcards on E.164 phone numbers. Patterns match as prefixes against the normalized E.164 string: `+1416*` matches any number starting with `+1416` (Toronto 416-area-code), and `+1900*` blocks any number starting with `+1900` (premium-rate).

**`dmPolicy`** in `access.json` has two values:
- `"allowlist"` — the default; owner + allowlist entries get through, everyone else is dropped
- `"disabled"` — only the owner gets through; all other numbers are dropped regardless of allowlist

---

## Prerequisites

Before you start, you'll need:

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **An SMS provider account** with a purchased DID (phone number). voip.ms is the tested reference; see [Providers](#providers) for alternatives.
- **A public HTTPS tunnel** pointing at your machine — [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (recommended, free), [ngrok](https://ngrok.com), or your own reverse proxy. The listener binds to `127.0.0.1` by default; the tunnel is how your provider reaches it.
- **Linux with `systemctl --user`** for the long-running listener service, or **macOS with `launchctl`** (both included). You can also run the listener under any process supervisor you prefer.
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — the client side of the plugin.

---

## Providers

The plugin is provider-agnostic. Set `SMS_PROVIDER` in your `.env` file to choose which one to use. There are two ways to connect a provider:

### Dedicated providers

These have their own implementation with **cryptographic webhook signature validation** — the strongest security for inbound webhooks. Covers ~55% of the global CPaaS market. **Implemented from API docs but not live-tested — please file an issue with your results if you try one.**

| Provider | `SMS_PROVIDER` | Signature |
|----------|---------------|-----------|
| [Twilio](https://www.twilio.com) | `twilio` | HMAC-SHA1 |
| [Vonage](https://www.vonage.com) | `vonage` | HMAC-SHA256 |
| [Telnyx](https://telnyx.com) | `telnyx` | ed25519 |
| [Plivo](https://www.plivo.com) | `plivo` | HMAC-SHA256 V3 |
| [MessageBird / Bird](https://bird.com) | `messagebird` | HMAC-SHA256 JWT |
| [Sinch](https://www.sinch.com) | `sinch` | HMAC-SHA256 |

### Generic provider (`SMS_PROVIDER=other`)

A **config-driven provider** that works with any REST-based SMS service. Instead of writing code, you describe your provider's API shape in a JSON config file. Uses token-based webhook authentication (shared secret in the URL or header). Covers the remaining ~35% of the market.

Set `SMS_PROVIDER=other` and create `~/.claude/channels/sms/other-provider.json` (see `other-provider.example.json` for the format). Pick a type preset that matches your provider's API pattern:

| Type | Auth | Body format | Best for |
|------|------|-------------|----------|
| `basic_json` | HTTP Basic | JSON | Bandwidth, ClickSend, BulkSMS, Burst SMS |
| `bearer_json` | Bearer token | JSON | Sinch, Telnyx, and similar |
| `apikey_json` | API key header | JSON | Infobip, MessageBird, Kaleyra, Textmagic |
| `basic_form` | HTTP Basic | Form-encoded | Twilio-like providers |
| `query_get` | Query params | Query params | voip.ms and similar legacy APIs |
| `custom` | Manual | Manual | Anything else |

**Tested:** [voip.ms](https://voip.ms) via `query_get`. Untested but documented: Bandwidth, ClickSend, BulkSMS, Burst SMS, Infobip, Textmagic, Kaleyra.

The dedicated providers (Twilio, Vonage, etc.) can also be used via the generic provider if you prefer simplicity over signature validation — just use `SMS_PROVIDER=other` with the appropriate type preset.

Want to add a dedicated provider with signature validation? See [Contributing a Provider](#contributing-a-provider).

---

## Quick Start

### 1. Install the plugin

The recommended install is via the Claude Code plugin marketplace:

```bash
claude plugin install sms@mattstein111/claude-code-sms
```

This downloads the plugin into `~/.claude/plugins/cache/` and wires up the skills (`/sms:configure`, `/sms:access`) and the MCP server automatically. Enable auto-update in the plugin menu to receive fixes as they ship.

<details>
<summary><strong>Alternative: install from source</strong></summary>

```bash
git clone https://github.com/mattstein111/claude-code-sms.git
cd claude-code-sms
bun install
```

Use this if you want to hack on the plugin itself, contribute a provider, or run against a local checkout.
</details>

### 2. Configure (guided)

**Recommended:** run `/sms:configure` inside a Claude Code session. It walks you through choosing a provider, entering credentials, setting the webhook token, and laying down `.env` and `access.json` with correct permissions.

<details>
<summary><strong>Manual configuration</strong></summary>

Create the state directory:

```bash
mkdir -p ~/.claude/channels/sms && chmod 700 ~/.claude/channels/sms
```

Create `~/.claude/channels/sms/.env` with your provider credentials. Every setup needs these common variables:

```env
SMS_PROVIDER=other               # see Providers section — voip.ms is the tested reference
OWNER_PHONE=+14165551234         # your personal phone number in E.164 — gets full trust
SMS_WEBHOOK_TOKEN=<random>       # secret for validating inbound webhooks (openssl rand -hex 24)
SMS_WEBHOOK_PATH=/incoming       # URL path the webhook listener accepts — obscure in production
LISTEN_PORT=5090                 # port the webhook listener binds to
```

Add the provider-specific variables (see [Provider Configuration](#provider-configuration) below).

Lock down the permissions:

```bash
chmod 600 ~/.claude/channels/sms/.env
```

Create `~/.claude/channels/sms/access.json` to define who can text in:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["+14165559999", "+1647*"],
  "blockList": ["+1900*"],
  "textChunkLimit": 160,
  "chunkMode": "length"
}
```

- `dmPolicy` — `"allowlist"` (owner + allowFrom) or `"disabled"` (owner only)
- `allowFrom` — phone numbers (or wildcard patterns) allowed to reach Claude Code
- `blockList` — numbers silently blocked (stored for audit, never delivered)
- `textChunkLimit` — outbound messages longer than this are split into multiple texts
- `chunkMode` — `"length"` for hard splits, `"newline"` to prefer paragraph breaks

The owner phone always has access regardless of the allowlist.
</details>

### 3. Start the webhook listener

The listener must be running to receive inbound SMS. For testing:

```bash
bun run listener
```

For production, install the included systemd user service (Linux):

```bash
cp systemd/sms-listener.service ~/.config/systemd/user/
# Edit the service file to match your Bun path and project directory
systemctl --user daemon-reload
systemctl --user enable --now sms-listener
```

macOS users: see `launchd/com.claude.sms-listener.plist`.

### 4. Expose the listener via a tunnel

Your SMS provider needs to reach the webhook listener. Cloudflare Tunnel is free and takes one command:

```bash
cloudflared tunnel --url http://localhost:5090
```

This prints a `https://<random>.trycloudflare.com` URL. For production, use a named Cloudflare Tunnel with a stable hostname. ngrok and other tunnels work the same way.

### 5. Configure your provider's webhook

In your SMS provider's portal, set the inbound message webhook URL to:

```
https://your-tunnel.example.com/<SMS_WEBHOOK_PATH>?token=<SMS_WEBHOOK_TOKEN>
```

> **Security note:** Putting the token in the URL query string means it may appear in provider-side request logs. Use a long random token (`openssl rand -hex 24`), treat it as a secret, and rotate it if your tunnel hostname leaks. Some providers support a header-based token — check the provider notes below.

The exact location of this setting varies by provider — see the provider-specific notes in [Provider Configuration](#provider-configuration).

### 6. Use it

Start Claude Code and send a text to your number. Claude will see it as a channel notification (see [What it looks like](#what-it-looks-like) above).

---

## Provider Configuration

Each provider requires its own set of environment variables in addition to the common ones. Click to expand:

### Dedicated providers

<details>
<summary><strong>Twilio</strong></summary>

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+14165551234
```

**Webhook setup:** In the Twilio console, go to your phone number's configuration. Under Messaging, set the "A MESSAGE COMES IN" webhook URL.

**Notes:** Twilio validates inbound webhooks with an `X-Twilio-Signature` header (HMAC-SHA1). The plugin verifies this automatically. Twilio supports up to 10 media URLs per MMS.
</details>

<details>
<summary><strong>Vonage / Nexmo</strong></summary>

```env
VONAGE_API_KEY=your_api_key
VONAGE_API_SECRET=your_api_secret
VONAGE_PHONE_NUMBER=+14165551234
VONAGE_SIGNATURE_SECRET=optional          # for webhook signature validation
```

**Webhook setup:** In the Vonage dashboard, navigate to Numbers > Your number and set the Inbound Webhook URL.

**Notes:** Uses the SMS API for plain text messages and the Messages API for MMS. Multi-image MMS sends each image as a separate API call.
</details>

<details>
<summary><strong>Telnyx</strong></summary>

```env
TELNYX_API_KEY=KEYxxxxxxxxxxxxxxxxxxxxxxxx
TELNYX_PHONE_NUMBER=+14165551234
TELNYX_PUBLIC_KEY=optional                # ed25519 webhook verification
TELNYX_MESSAGING_PROFILE_ID=optional
```

**Webhook setup:** In the Telnyx Mission Control Portal, configure the messaging webhook URL for your number or messaging profile.

**Notes:** Uses bearer token authentication. Native MMS support with a `media_urls` array in the API.
</details>

<details>
<summary><strong>Plivo</strong></summary>

```env
PLIVO_AUTH_ID=your_auth_id
PLIVO_AUTH_TOKEN=your_auth_token
PLIVO_PHONE_NUMBER=+14165551234
PLIVO_SIGNATURE_V3_TOKEN=optional         # V3 webhook validation
```

**Webhook setup:** In the Plivo console, go to Messaging > Applications and set the Message URL.

**Notes:** Uses HTTP Basic authentication. Phone numbers are sent without the `+` prefix in the Plivo API (the plugin handles this conversion internally).
</details>

<details>
<summary><strong>MessageBird / Bird</strong></summary>

```env
MESSAGEBIRD_ACCESS_KEY=your_access_key
MESSAGEBIRD_PHONE_NUMBER=+14165551234
MESSAGEBIRD_SIGNING_KEY=optional          # for JWT webhook signature validation
```

**Webhook setup:** In the MessageBird dashboard, go to Developers > API Settings and configure the webhook URL for inbound messages.

**Notes:** Uses an AccessKey header for API authentication. Webhooks are signed with an HMAC-SHA256 JWT in the `MessageBird-Signature-JWT` header when a signing key is configured. Supports both SMS and MMS.
</details>

<details>
<summary><strong>Sinch</strong></summary>

```env
SINCH_SERVICE_PLAN_ID=your_service_plan_id
SINCH_API_TOKEN=your_api_token
SINCH_PHONE_NUMBER=+14165551234
SINCH_REGION=us                           # optional, default: us
SINCH_WEBHOOK_SECRET=optional             # for HMAC-SHA256 webhook validation
```

**Webhook setup:** In the Sinch dashboard, configure the callback URL for your service plan under SMS > APIs.

**Notes:** Uses bearer token authentication. The API region defaults to `us` but can be set to `eu`, `au`, etc. Webhooks are optionally signed with HMAC-SHA256 when a webhook secret is configured.
</details>

### Generic provider

<details>
<summary><strong>Generic / Other</strong> (<code>SMS_PROVIDER=other</code>)</summary>

The generic provider uses a JSON configuration file instead of environment variables for API shape. You still need the common env vars (`OWNER_PHONE`, `SMS_WEBHOOK_TOKEN`, etc.) plus any credentials referenced in your config.

1. Copy `other-provider.example.json` to `~/.claude/channels/sms/other-provider.json`
2. Edit the config to match your provider's API
3. Set any referenced env vars (credentials) in your `.env`

**Example — voip.ms via generic provider:**

```json
{
  "type": "query_get",
  "name": "voipms",
  "from_number": "+14165551234",
  "send": {
    "url": "https://voip.ms/api/v1/rest.php",
    "body": {
      "api_username": "{{env.VOIPMS_USER}}",
      "api_password": "{{env.VOIPMS_API_PASSWORD}}",
      "method": "sendSMS",
      "did": "{{from}}",
      "dst": "{{to}}",
      "message": "{{message}}"
    },
    "response_id_path": "sms",
    "phone_format": "digits"
  },
  "webhook": {
    "fields": {
      "from": "from",
      "to": "to",
      "message": "message",
      "message_id": "id",
      "media_urls": "media"
    }
  }
}
```

With `.env`:
```env
SMS_PROVIDER=other
VOIPMS_USER=user@example.com
VOIPMS_API_PASSWORD=your_api_password
```

**Template variables:** `{{to}}`, `{{from}}`, `{{message}}` for message fields; `{{env.VAR_NAME}}` for environment variables.

**Phone formats:** `e164` (+14165551234), `digits` (14165551234), `national` (4165551234).

See `other-provider.example.json` for the full schema with all options.
</details>

---

## Tools

Claude Code gets three tools from this plugin:

### `send`

Send an SMS or MMS message to a phone number. The recipient must be on the allowlist or be the owner. Messages longer than `textChunkLimit` (default 160) are automatically split into multiple texts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Recipient phone number in E.164 format (`+1XXXXXXXXXX`) |
| `text` | string | yes | Message body |
| `media_urls` | string[] | no | Publicly accessible URLs for MMS attachments (max varies by provider, typically 3, max 1300KB each) |

**Returns:** Confirmation text with the provider's message ID. Errors come back with `isError: true` and an explanatory message (e.g., blocked recipient, send failure).

### `fetch_messages`

Retrieve conversation history with a specific phone number. Returns messages in chronological order (oldest first). Includes both inbound and outbound messages so Claude can reconstruct the full thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `phone` | string | yes | Phone number in E.164 format |
| `limit` | number | no | Maximum messages to return (default 30, capped at 200) |

**Returns:** A JSON array of message objects:

```json
[
  {
    "id": 42,
    "timestamp": "2026-04-16T23:44:49Z",
    "direction": "in",
    "phone": "+14165551234",
    "did": "+16475551234",
    "message": "Test message",
    "media": "/path/to/file1.jpg,/path/to/file2.png"
  }
]
```

`did` and `media` are omitted when empty.

### `download_attachment`

Get local file paths for MMS media that was downloaded when the message arrived.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message_id` | string | yes | Message ID from the database |
| `chat_id` | string | yes | Phone number (E.164) the message belongs to — access scoping |

**Returns:** A JSON array of `{ path, name }` objects — one per attachment. The file paths point inside `~/.claude/channels/sms/media/`; Claude can read them directly. Returns an error if the message doesn't exist or doesn't belong to `chat_id`.

---

## Permission Relay

The owner can approve or deny Claude Code tool calls remotely via text message. This works through the Claude Code channel permission system:

```mermaid
sequenceDiagram
    participant C as Claude Code
    participant M as MCP Server
    participant P as SMS Provider
    participant O as Owner's Phone

    C->>M: Permission request<br/>"Bash: npm install"
    M->>P: sendSMS to owner
    P->>O: [Permission] Claude wants to:<br/>Run npm install.<br/>Tool: Bash<br/>Reply "yes 7q3fp" or "no 7q3fp"
    O->>P: "yes 7q3fp"
    P-->>M: webhook → listener → DB
    M->>C: permission: allow
    Note over C: Proceeds with<br/>npm install
```

The MCP server intercepts inbound messages from the owner that match `y|yes|n|no <code>` where `<code>` is the 5-character ID from the permission request. The match is **case-insensitive** and tolerates leading/trailing whitespace, so `YES 7q3fp`, `y 7q3fp`, and `  no 7q3fp  ` all work. Matched messages are consumed by the permission system and not delivered as regular messages.

Only the owner phone number can approve or deny permissions. If anyone else sends `yes 7q3fp`, it's treated as a normal message. Each request ID can only be used once (replay-protected for 1 hour).

---

## Skills

| Skill | Description |
|-------|-------------|
| `/sms:configure` | Interactive setup — walks you through choosing a provider, entering credentials, setting the webhook token, and configuring access control |
| `/sms:access` | Manage the phone allowlist, blocklist, and pairing approvals |

`/sms:access` subcommands:

| Subcommand | Description |
|------------|-------------|
| `list` | Show current policy, allowlist, and blocklist |
| `allow <phone>` | Add a number or pattern to the allowlist |
| `block <phone>` | Add a number or pattern to the blocklist |
| `remove <phone>` | Remove a number from both lists |
| `policy <allowlist\|disabled>` | Set the DM policy |
| `pair <code>` | Approve a pending pairing request |

---

## Rate Limiting & Retention

### Rate Limiting

The webhook listener enforces per-phone-number rate limits **in memory, before writing anything to the database**. This prevents a malicious or misbehaving number from flooding the database with messages.

| Setting | Env var | Default |
|---------|---------|---------|
| Messages per minute per number | `RATE_LIMIT_PER_MINUTE` | 10 |
| Messages per hour per number | `RATE_LIMIT_PER_HOUR` | 100 |

Rate-limited messages are silently dropped with a 200 response (so the provider doesn't retry). The rate limiter uses an in-memory sliding window — zero disk I/O, and it resets when the listener restarts.

### Message Retention

Both inbound and outbound messages are stored in the database so that Claude Code can always reconstruct the full conversation with any counterparty. To prevent unbounded growth, the listener runs a retention purge on startup and every 24 hours:

| Setting | Env var | Default |
|---------|---------|---------|
| Max messages kept per counterparty | `RETENTION_MAX_PER_PHONE` | 1000 |
| Max age for any message | `RETENTION_MAX_DAYS` | 180 days |
| Max age for blocked messages | `RETENTION_BLOCKED_DAYS` | 3 days |

Set any value to `0` to disable that particular rule.

The purge also cleans up stale session data: sessions that haven't polled in over an hour are marked inactive, and dead sessions (along with their delivery records) are removed after 7 days.

---

## Database Schema

The SQLite database has three tables:

**`messages`** — Append-only log of all SMS traffic. The webhook listener writes inbound messages; the MCP server writes outbound messages. No delivery state is stored here.

| Column | Description |
|--------|-------------|
| `id` | Auto-incrementing primary key |
| `timestamp` | ISO 8601 timestamp |
| `direction` | `"in"` or `"out"` |
| `phone` | Counterparty phone number (E.164) |
| `did` | Local phone number that sent/received (E.164) |
| `message` | Message text |
| `media` | Comma-separated local file paths for MMS attachments |
| `provider_msg_id` | Provider-specific message ID (used for deduplication) |
| `blocked` | `1` if blocklisted, `0` otherwise |

**`sessions`** — One row per MCP server instance. Tracks which DIDs the session subscribes to and its high-water mark for efficient polling.

**`deliveries`** — Per-session, per-message delivery tracking. When an MCP server delivers a message to Claude Code, it records the `(session_id, message_id)` pair here. This is what enables multiple Claude Code sessions to independently see the same inbound messages.

---

## Data Directory

All runtime state lives under `~/.claude/channels/sms/`:

```
~/.claude/channels/sms/
├── .env                     # Provider credentials and config (chmod 600)
├── access.json              # Allowlist, blocklist, and chunking settings
├── other-provider.json      # Generic provider config (when SMS_PROVIDER=other)
├── sms.db                   # SQLite database (messages, sessions, deliveries)
├── media/                   # Downloaded MMS attachments
├── approved/                # Pairing approval marker files
└── logs/
    └── listener.log         # Webhook listener log (JSON lines, one entry per line)
```

The plugin enforces restrictive permissions on creation — the directory gets `chmod 700` and `.env` gets `chmod 600`. Don't loosen these; the tooling treats `.env` as a secret.

---

## Troubleshooting

**Messages aren't arriving in Claude Code.**
- Check the listener is running: `systemctl --user status sms-listener` (Linux) or `launchctl list | grep sms` (macOS).
- Tail the listener log: `tail -f ~/.claude/channels/sms/logs/listener.log`. Every inbound webhook shows up here, along with the gate decision.
- Confirm your tunnel is up — `curl https://your-tunnel.example.com/<path>?token=<wrong>` should return `401`. If it returns connection errors, the tunnel isn't reaching `localhost:5090`.

**Provider reports `401 Unauthorized` on webhook delivery.**
- Token mismatch. Compare `SMS_WEBHOOK_TOKEN` in `.env` against the `?token=` value in your provider's webhook URL.
- Some providers URL-encode the query string differently — check the listener log for what token value it's actually seeing.

**Message arrives but Claude never sees it.**
- The sender is probably not on the allowlist. Check the log for `drop: not_on_allowlist`. Add them via `/sms:access allow +1XXXXXXXXXX` or edit `access.json`.
- If `dmPolicy` is `"disabled"`, only the owner phone gets through — everyone else is dropped.

**Claude sees messages but can't send.**
- The recipient must be on the allowlist or be the owner. Non-allowlisted outbound targets are refused by the `send` tool.
- Check provider credentials in `.env`. Run `bun run server.ts` directly to surface startup errors on stderr.

**Permission relay doesn't work.**
- Owner phone must match exactly (E.164, same as `OWNER_PHONE` in `.env`).
- The reply has to look like `y <code>`, `yes <code>`, `n <code>`, or `no <code>` — other wording is treated as a normal message.
- Each request ID is single-use and expires after an hour.

**MCP server crashed on startup.**
- Usually a missing env var or malformed provider config. Check the Claude Code startup output for the MCP server's stderr.
- `/sms:configure` validates most common misconfigurations — re-running it is often faster than debugging by hand.

---

## Contributing a Provider

The provider interface (`providers/interface.ts`) is intentionally small — typically 50-100 lines per implementation. See [`providers/twilio.ts`](providers/twilio.ts) for a reference implementation of a signature-validating provider, or [`providers/other.ts`](providers/other.ts) for the config-driven generic provider.

```typescript
interface SmsProvider {
  name: string
  webhookMethod: "GET" | "POST" | "GET|POST"
  validateConfig(): void
  getFromNumber(): string
  sendSMS(to: string, message: string): Promise<SendResult>
  sendMMS(to: string, message: string, mediaUrls: string[]): Promise<SendResult>
  parseWebhook(req: Request): Promise<InboundMessage | null>
  fetchMedia(providerMessageId: string): Promise<string[]>
}
```

To add a new provider:

1. Create `providers/<name>.ts` implementing `SmsProvider`
2. Import and register it in `providers/index.ts`
3. Document the required env vars in the README and the `/sms:configure` skill

Phone numbers arrive as E.164 (`+14165551234`). Your provider module converts to whatever format the API expects (e.g., Plivo strips the `+`, Twilio uses E.164 as-is).

> **Before writing a dedicated provider**, check whether the generic provider (`SMS_PROVIDER=other`) can handle your use case. Dedicated providers are only needed when the provider has a bespoke webhook signature scheme that can't be expressed as simple token validation.

---

## Known Limitations

- **Claude Code channels are a research preview.** There are known upstream bugs where notifications can be silently dropped when the session is idle, or duplicate plugin instances can be spawned. These are Claude Code issues, not plugin bugs.
- **Webhook reliability** — if the listener process is down when a provider fires a webhook, that message is lost. Most providers do not retry. The systemd service with auto-restart mitigates this.
- **Outbound MMS** requires that media URLs are publicly accessible on the internet — the SMS provider fetches the media from the URL you provide. This plugin does not host or proxy files.
- **Long messages** are chunked at 160 characters by default (the standard SMS segment size). This is configurable via `textChunkLimit` in `access.json`.
- **Dedicated providers** (Twilio, Vonage, Telnyx, Plivo, MessageBird, Sinch) are implemented based on API documentation but have not been tested with live accounts. The generic provider has been tested with voip.ms. See [GitHub issues](https://github.com/mattstein111/claude-code-sms/issues) for testing status.

---

## License

Personal project, offered as-is without a formal license. Feel free to read, experiment, and self-host. If you need an explicit license for your use case (redistribution, commercial use, etc.), open an issue and we can sort it out.
