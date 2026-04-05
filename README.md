# claude-code-sms

Claude Code channel plugin for two-way SMS/MMS communication via [voip.ms](https://voip.ms). Send and receive text messages from within a Claude Code session.

## Overview

This plugin gives Claude Code a phone number. People can text it, and Claude Code receives those messages as channel notifications. Claude Code can reply via SMS/MMS using the `send` tool.

**Key features:**
- Two-way SMS/MMS via voip.ms
- Owner phone number with full trust (including remote permission approve/deny)
- Allowlist + blocklist with wildcard pattern support
- Persistent webhook listener — no messages lost when Claude Code isn't running
- MMS media download and storage
- Message history in SQLite

## Architecture

Two-process design to ensure no messages are ever lost:

```
voip.ms webhook --> Cloudflare tunnel --> Webhook Listener (always on, systemd)
                                               |
                                               v writes
                                          SQLite DB
                                               |
                                               v polls (1.5s)
                                          MCP Server (runs with Claude Code)
                                               |
                                               v
                                 notifications/claude/channel --> Claude Code

Claude Code --> send tool --> voip.ms REST API --> recipient phone
                           --> also writes to SQLite DB
```

### Webhook Listener (`listener.ts`)

Always-on HTTP server running as a systemd user service. Receives incoming SMS/MMS webhooks from voip.ms (via Cloudflare tunnel), validates the webhook token, downloads MMS media, deduplicates, and writes to SQLite.

**Why separate?** voip.ms fires webhooks once with no retry. If we only listened when Claude Code was running, messages received while it's down would be permanently lost.

### MCP Server (`server.ts`)

Spawned by Claude Code as a subprocess over stdio. Polls the SQLite database for undelivered inbound messages and emits them as MCP channel notifications. Exposes tools for sending SMS/MMS and fetching history.

## Trust Model

Three tiers of phone numbers:

| Tier | Source | Behavior |
|------|--------|----------|
| **Owner** | `OWNER_PHONE` in `.env` | Full trust. Permission relay (approve/deny tool calls via text). Messages tagged with `owner="true"` in notification meta. |
| **Allowlisted** | `allowFrom` in `access.json` | Untrusted. Messages delivered to Claude Code with no special flags. Claude Code should not act on instructions from these numbers without owner approval. |
| **Blocklisted** | `blockList` in `access.json` | Silently dropped. Stored in DB for audit but never delivered to Claude Code. |
| **Unknown** | Not in any list | Dropped (or enters pairing flow if configured). |

Both allowlist and blocklist support glob wildcards on E.164 numbers (e.g., `+1416*` matches all Toronto 416 numbers).

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- A [voip.ms](https://voip.ms) account with a DID (phone number) and API access enabled
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

cat > ~/.claude/channels/sms/.env << 'EOF'
VOIPMS_USER=user@example.com
VOIPMS_API_PASSWORD=your_api_password
VOIPMS_DID=6474837416
OWNER_PHONE=+14165551234
SMS_WEBHOOK_TOKEN=$(openssl rand -hex 24)
SMS_WEBHOOK_PATH=/sms-secret123/incoming
LISTEN_PORT=5090
EOF

chmod 600 ~/.claude/channels/sms/.env
```

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

### 4. Set up voip.ms webhook

In the voip.ms portal:
1. Go to **DID Numbers** > **Manage DID** > Edit your DID
2. Under **SMS/MMS**, set the **URL Callback** to your Cloudflare tunnel URL + webhook path
3. Append `?token=YOUR_WEBHOOK_TOKEN` to the URL
4. Example: `https://sms.yourdomain.com/sms-secret123/incoming?token=abc123...`

### 5. Start the webhook listener

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

### 6. Install the Claude Code plugin

The plugin auto-registers via `.claude-plugin/plugin.json` when the repo is in your project directory. Claude Code will spawn the MCP server automatically.

## Tools

### `send`

Send an SMS or MMS message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Phone number in E.164 format |
| `text` | string | yes | Message text |
| `media_urls` | string[] | no | Public URLs for MMS (max 3, max 1300KB each) |

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

- `/sms:configure` — Set up voip.ms credentials and webhook settings
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
├── .env                    # voip.ms credentials (chmod 600)
├── access.json             # phone allowlist + blocklist
├── sms.db                  # SQLite message database
├── media/                  # downloaded MMS attachments
├── approved/               # pairing approval marker files
└── logs/
    └── listener.log        # webhook listener log
```

## Development

```bash
bun run listener    # start webhook listener
bun run server      # MCP server (normally spawned by Claude Code)
```

## Known Limitations

- Claude Code channels are a **research preview** (launched March 2026). There are known bugs with notification delivery.
- voip.ms webhooks fire once with no retry — the persistent listener mitigates this, but if the listener is down during a webhook, that message is lost.
- MMS media URLs for outbound messages must be publicly accessible (voip.ms fetches them). The plugin does not host media.
- SMS messages are chunked at 160 characters by default. Long messages become multiple texts.
