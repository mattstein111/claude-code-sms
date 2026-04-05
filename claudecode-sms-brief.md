# Project Brief: claudecode-sms

**Goal:** Build a Claude Code channel plugin that enables two-way SMS/MMS communication via voip.ms.

**Repo:** `claudecode-sms` (private, GitHub). Completely self-contained — no external dependencies on other projects or services.

## What this is

An MCP server (TypeScript, runs under Bun) that Claude Code spawns as a subprocess over stdio. It:
1. Runs a persistent webhook listener to receive incoming SMS/MMS from voip.ms
2. Sends outgoing SMS/MMS via the voip.ms REST API
3. Stores all message history in its own SQLite database
4. Exposes MCP tools: `reply`, `fetch_messages`, `download_attachment`
5. Delivers inbound messages as `notifications/claude/channel` MCP notifications
6. Supports permission relay (approve/deny tool calls via text message)

## Architecture

The plugin has two components:

### 1. Webhook Listener (always on, systemd service)
A lightweight HTTP server that receives incoming SMS/MMS webhooks from voip.ms (via Cloudflare tunnel), validates them, downloads any MMS media, and writes everything to a SQLite database. This runs independently of Claude Code so no messages are ever lost.

### 2. MCP Server (runs with Claude Code)
Polls the SQLite database for new inbound messages and delivers them to the Claude Code session as MCP channel notifications. Sends outbound SMS/MMS directly via the voip.ms REST API and logs them to the same database.

```
voip.ms webhook → Cloudflare tunnel → Webhook Listener (always on)
                                            ↓ writes
                                       SQLite DB
                                            ↓ polls (1-2s)
                                       MCP Server (runs with Claude Code)
                                            ↓
                              notifications/claude/channel → Claude Code

Claude Code → reply tool → voip.ms REST API → recipient phone
                         → also writes to SQLite DB
```

**Why two components:** voip.ms fires webhooks once with no retry. If the MCP server only runs when Claude Code is running, messages received while Claude Code is down would be lost. The persistent listener ensures all messages are captured. The MCP server catches up on startup via a high-water mark.

## voip.ms REST API

**Send SMS:**
```
GET https://voip.ms/api/v1/rest.php?api_username={user}&api_password={pass}&method=sendSMS&did={from}&dst={to}&message={urlencoded_msg}
```

**Send MMS (up to 3 media URLs, max 1300KB each):**
```
GET https://voip.ms/api/v1/rest.php?api_username={user}&api_password={pass}&method=sendMMS&did={from}&dst={to}&message={urlencoded_msg}&media1={url}&media2={url}&media3={url}
```

**Get MMS media (fallback if webhook doesn't include media URLs):**
```
GET https://voip.ms/api/v1/rest.php?api_username={user}&api_password={pass}&method=getMMS&id={sms_id}
```

Response format: `{"status":"success",...}` or `{"status":"some_error",...}`

Phone numbers to voip.ms API: 11 digits, no `+` prefix (e.g., `14165551234`).

**Incoming webhook format:** voip.ms sends a GET request with query parameters:
- `to` — destination DID
- `from` — sender phone number
- `message` — message text (URL-encoded)
- `id` — voip.ms message ID
- `media` — comma-separated media URLs (if MMS, may be empty — use getMMS as fallback)
- Token is also passed as a query parameter for validation

Supported MMS types: JPG, GIF, PNG, MP3, WAV, MIDI, MP4, 3GP.

## Configuration

All config lives under a single state directory (default `~/.claude/channels/sms/`).

### Credentials: `.env` (chmod 600)
```
VOIPMS_USER=user@example.com
VOIPMS_API_PASSWORD=yourpassword
VOIPMS_DID=6474837416
SMS_WEBHOOK_TOKEN=your_webhook_secret
SMS_WEBHOOK_PATH=/your-obscured-path/incoming
LISTEN_PORT=5090
```

### Directory layout
```
~/.claude/channels/sms/
├── .env                    # voip.ms credentials (chmod 600)
├── access.json             # phone allowlist + policy (chmod 600)
├── sms.db                  # SQLite message database
├── media/                  # downloaded MMS attachments
├── approved/               # pairing approval marker files (polled by MCP server)
└── logs/
    └── listener.log        # webhook listener log
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,          -- ISO 8601 (YYYY-MM-DDTHH:MM:SSZ)
  direction TEXT NOT NULL,          -- "in" or "out"
  phone TEXT NOT NULL,              -- E.164 normalized (+1XXXXXXXXXX)
  message TEXT NOT NULL DEFAULT '',
  media TEXT DEFAULT '',            -- comma-separated local file paths
  voipms_id TEXT DEFAULT ''         -- voip.ms message ID (for dedup)
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_direction_id ON messages(direction, id);
```

## MCP Server Specification

### Capabilities
```typescript
const mcp = new Server(
  { name: 'sms', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: `The sender reads SMS, not this session. Anything you want them to see must go through the reply tool.

Messages from SMS arrive as <channel source="sms" chat_id="..." message_id="..." user="..." ts="...">. Reply with the reply tool — pass chat_id (phone number) back.

reply accepts media_urls for MMS attachments (must be publicly accessible URLs, max 3, max 1300KB each). Supported: JPG, GIF, PNG, MP3, WAV, MP4.`,
  }
)
```

### Notification format

**Inbound message:**
```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "Hey, are you around?",
    "meta": {
      "chat_id": "+14165551234",
      "message_id": "42",
      "user": "+14165551234",
      "user_id": "+14165551234",
      "ts": "2026-04-04T14:23:45Z",
      "attachment_count": "1",
      "attachments": "photo.jpg (image/jpeg)"
    }
  }
}
```

**Permission request (Claude Code → MCP server → SMS to allowlisted users):**
```json
{
  "method": "notifications/claude/channel/permission_request",
  "params": {
    "request_id": "abcde",
    "tool_name": "Bash",
    "description": "Run npm install",
    "input_preview": "{\"command\":\"npm install\"}"
  }
}
```

Format as SMS: `[Permission] Claude wants to: Run npm install. Reply "yes abcde" or "no abcde"`

**Permission response (SMS reply intercepted → Claude Code):**
Intercept inbound messages matching `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` and emit:
```json
{
  "method": "notifications/claude/channel/permission",
  "params": {
    "request_id": "abcde",
    "behavior": "allow"
  }
}
```

### Tools

**reply**
```typescript
{
  name: 'reply',
  description: 'Send an SMS or MMS message',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: 'Phone number in E.164 format (+1XXXXXXXXXX)' },
      text: { type: 'string', description: 'Message text' },
      reply_to: { type: 'string', description: 'Message ID to quote (optional)' },
      media_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Publicly accessible media URLs for MMS (max 3, max 1300KB each)',
      },
    },
    required: ['chat_id', 'text'],
  },
}
```
- Validate chat_id against access allowlist before sending
- Call voip.ms sendSMS or sendMMS depending on whether media_urls present
- Log outgoing message to SQLite
- Return confirmation with message ID

**fetch_messages**
```typescript
{
  name: 'fetch_messages',
  description: 'Fetch recent SMS/MMS conversation history with a phone number',
  inputSchema: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone number in E.164 format' },
      limit: { type: 'number', description: 'Max messages to return (default 30)' },
    },
    required: ['phone'],
  },
}
```
- Query SQLite, return chronological (oldest first) with timestamps, direction, message text, media paths

**download_attachment**
```typescript
{
  name: 'download_attachment',
  description: 'Get local file paths for MMS media on a message',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string' },
      message_id: { type: 'string' },
    },
    required: ['chat_id', 'message_id'],
  },
}
```
- Look up message in SQLite, parse media column, return file paths + metadata

## Access Control

File: `access.json` (chmod 600, re-read before every inbound message delivery)

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["+14165551234"],
  "textChunkLimit": 160,
  "chunkMode": "length"
}
```

No groups/mentions — SMS is always 1:1 DM.

**Gate function:** Before delivering any inbound message or allowing any outbound send, check the phone number against `allowFrom`. Drop silently if not listed.

**Pairing flow (optional, can start with allowlist-only):**
- Unknown number texts in → server generates 6-char hex code, replies via SMS with instructions
- User runs `/sms:access pair <code>` in Claude Code terminal
- Skill writes approval file to `approved/<phone>` directory
- MCP server polls `approved/` dir every 5 seconds, confirms via SMS, adds to `allowFrom`
- Pairing codes expire after 1 hour, max 3 pending at a time, max 2 reply attempts per code

## Phone Number Normalization

```typescript
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`
  return `+${digits}`
}

function toVoipMs(e164: string): string {
  return e164.replace('+', '')
}
```

Apply normalization at every entry point (webhook inbound, tool call arguments, access.json reads).

## DB Polling (MCP Server)

```typescript
let highWaterMark = 0

function startPolling() {
  // On startup: set highWaterMark to current max(id) so we don't replay old history
  // Optionally: set to max(id) - N to deliver N recent messages as context
  const row = db.prepare('SELECT MAX(id) as maxId FROM messages').get()
  highWaterMark = row?.maxId ?? 0

  setInterval(() => {
    const rows = db.prepare(
      'SELECT id, timestamp, direction, phone, message, media FROM messages WHERE id > ? AND direction = ? ORDER BY id ASC'
    ).all(highWaterMark, 'in')

    for (const row of rows) {
      highWaterMark = row.id
      const gateResult = gate(row.phone)
      if (gateResult.action === 'drop') continue

      // Check for permission reply
      const permMatch = PERMISSION_REPLY_RE.exec(row.message)
      if (permMatch) {
        mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: permMatch[2].toLowerCase(),
            behavior: permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
          },
        })
        continue
      }

      // Build notification
      const meta: Record<string, string> = {
        chat_id: row.phone,
        message_id: String(row.id),
        user: row.phone,
        user_id: row.phone,
        ts: row.timestamp,
      }
      if (row.media) {
        const files = row.media.split(',').filter(Boolean)
        meta.attachment_count = String(files.length)
        meta.attachments = files.map(f => f.split('/').pop()).join('; ')
      }

      mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: row.message || '(attachment)', meta },
      })
    }
  }, 1500)
}
```

## Webhook Listener (Persistent Service)

Standalone HTTP server (can be a separate `.ts` file or a simple Python script). Runs as a systemd user service.

**Responsibilities:**
1. Listen on configured port for GET requests at the configured webhook path
2. Validate webhook token
3. Return 200 immediately (voip.ms doesn't retry)
4. Normalize phone numbers
5. Download MMS media (from webhook `media` param, or fallback to `getMMS` API)
6. Save media files to `media/` directory with timestamped filenames
7. Write message row to SQLite
8. Log to `logs/listener.log`

**Dedup:** Use `voipms_id` column to skip duplicate webhook deliveries.

**Systemd unit:** Ship a template service file in the repo.

## Message Chunking

```typescript
function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  if (mode === 'newline') {
    // Prefer splitting at paragraph breaks, fall back to length
  }
  // Length mode: hard split at limit
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit))
  }
  return chunks
}
```

Default: 160 chars, length mode (standard SMS segment size).

## Skills

### /sms:configure
Set voip.ms credentials and webhook settings. Writes to `.env` file with chmod 600.

### /sms:access
Manage phone allowlist and approve pairings. Reads/writes `access.json`. Subcommands:
- `pair <code>` — approve a pending pairing request
- `allow <phone>` — add a phone to allowlist
- `remove <phone>` — remove a phone from allowlist
- `list` — show current policy and allowlist
- `policy <allowlist|disabled>` — set DM policy

## File Structure

```
claudecode-sms/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── server.ts                  # MCP server (polls DB, exposes tools, sends SMS)
├── listener.ts                # Webhook listener (receives SMS, writes to DB)
├── db.ts                      # SQLite schema + helpers
├── voipms.ts                  # voip.ms API client (sendSMS, sendMMS, getMMS)
├── access.ts                  # Access control (gate, pairing, allowlist)
├── phone.ts                   # Phone normalization utilities
├── package.json
├── tsconfig.json
├── systemd/
│   └── sms-listener.service   # Template systemd unit for webhook listener
├── skills/
│   ├── access/
│   │   └── SKILL.md
│   └── configure/
│       └── SKILL.md
├── .gitignore
├── README.md
└── CLAUDE.md
```

## Key Implementation Patterns

1. **Graceful shutdown:** MCP server listens for stdin EOF + SIGTERM/SIGINT. Clean up DB connections, stop polling.
2. **Unhandled rejection protection:** `process.on('unhandledRejection', ...)` — prevent silent death.
3. **Atomic file writes:** Write access.json via `.tmp` then rename.
4. **File security:** Never expose `.env` or `access.json` via tools. Validate all file paths.
5. **Stderr logging:** All debug output to `process.stderr.write()` — stdout is reserved for MCP protocol over stdio.
6. **E.164 everywhere:** Normalize phone numbers at every boundary.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol
- `better-sqlite3` — SQLite access (or use Bun's built-in `bun:sqlite`)
- No other runtime dependencies. Keep it minimal.

## Known Caveat

Claude Code channels are a **research preview** (launched March 2026). There are known bugs with notification delivery (GitHub issues on anthropics/claude-code). The Discord channel plugin works today, so the core path is functional, but be aware during testing.
