# claude-code-sms

Claude Code channel plugin for two-way SMS/MMS via voip.ms.

## Architecture

Two-process design:
1. **Webhook listener** (`listener.ts`) — always-on systemd service. Receives voip.ms webhooks, validates token, downloads MMS media, writes to SQLite. Must run independently so no messages are lost.
2. **MCP server** (`server.ts`) — spawned by Claude Code over stdio. Polls SQLite for undelivered inbound messages, emits channel notifications, exposes tools for sending SMS/MMS.

They share a SQLite database at `~/.claude/channels/sms/sms.db`.

## Configuration

All state lives under `~/.claude/channels/sms/`:
- `.env` — voip.ms credentials, webhook token, owner phone number
- `access.json` — allowlist/blocklist with wildcard support
- `sms.db` — message database
- `media/` — downloaded MMS attachments

## Key conventions

- Phone numbers are E.164 everywhere (`+14165551234`)
- voip.ms API wants 11 digits without `+` prefix
- All stdout is reserved for MCP protocol — debug logging goes to stderr
- Owner phone (in `.env`) has full trust including permission relay
- All other numbers are untrusted — messages delivered but flagged
- Blocklisted numbers are stored in DB for audit but never delivered to Claude Code
- Allowlist/blocklist support glob wildcards (e.g. `+1416*`)

## Tools exposed

- `send` — send SMS/MMS to a phone number
- `fetch_messages` — get conversation history
- `download_attachment` — get local file paths for MMS media

## Running

```bash
bun install
bun run listener    # start webhook listener
bun run server      # MCP server (normally spawned by Claude Code)
```
