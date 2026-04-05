# claude-code-sms

Claude Code channel plugin for two-way SMS/MMS with pluggable provider support.

## Architecture

Two-process design, multi-instance safe:
1. **Webhook listener** (`listener.ts`) — always-on systemd service. Receives provider webhooks, validates via provider module, downloads MMS media, writes to SQLite. Must run independently so no messages are lost.
2. **MCP server** (`server.ts`) — spawned by Claude Code over stdio. Registers a session, polls SQLite for undelivered messages, emits channel notifications, exposes tools for sending SMS/MMS. Multiple instances can run concurrently.

They share a SQLite database at `~/.claude/channels/sms/sms.db`.

## Multi-instance design

Multiple Claude Code sessions on the same machine all see the same inbound messages:
- `messages` table is a pure append-only log (no delivery state on messages)
- `sessions` table tracks each MCP server instance (session ID, subscribed DIDs, high-water mark)
- `deliveries` table tracks per-session, per-message delivery
- Each session independently catches up from where it left off
- Sessions can subscribe to specific DIDs via `SMS_SUBSCRIBE_DIDS` env var
- Stale sessions (no poll in 1 hour) are automatically marked inactive
- Dead session data cleaned up after 7 days

## Providers

Provider implementations live in `providers/`. Set `SMS_PROVIDER` in `.env` to select one.

| Provider | File | Status |
|----------|------|--------|
| voip.ms | `providers/voipms.ts` | Tested |
| Twilio | `providers/twilio.ts` | Untested |
| Vonage | `providers/vonage.ts` | Untested |
| Telnyx | `providers/telnyx.ts` | Untested |
| Plivo | `providers/plivo.ts` | Untested |

Interface: `providers/interface.ts`. Registry: `providers/index.ts`.

## Configuration

All state lives under `~/.claude/channels/sms/`:
- `.env` — SMS_PROVIDER + provider-specific credentials, webhook token, owner phone
- `access.json` — allowlist/blocklist with wildcard support
- `sms.db` — message database (shared by all sessions)
- `media/` — downloaded MMS attachments

## Key conventions

- Phone numbers are E.164 everywhere (`+14165551234`)
- Each provider converts to its own format internally (e.g. voip.ms strips `+`)
- All stdout is reserved for MCP protocol — debug logging goes to stderr
- Owner phone (in `.env`) has full trust including permission relay
- All other numbers are untrusted — messages delivered with E.164 phone only
- Blocklisted numbers are stored in DB (`blocked = 1`) but never delivered to Claude Code
- Allowlist/blocklist support glob wildcards (e.g. `+1416*`)
- `did` column tracks which local number sent/received (enables multi-number support)

## Rate limiting & retention

- In-memory rate limiter in the listener (per phone, sliding window, before DB write)
- Defaults: 10/min, 100/hour per number. Configurable via `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_HOUR`
- Retention per counterparty: keep last 1000 messages, max 180 days. Blocked purge after 3 days.
- Configurable via `RETENTION_MAX_PER_PHONE`, `RETENTION_MAX_DAYS`, `RETENTION_BLOCKED_DAYS`
- Purge runs on listener startup + daily

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
