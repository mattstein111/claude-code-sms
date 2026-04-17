---
name: sms:access
description: Manage the SMS channel blocklist and DM policy
user_invocable: true
---

# /sms:access

Manage phone number access for the SMS channel plugin.

There is no inbound allowlist — any non-blocked number reaches the session, and the model decides what to do (respond, ignore, escalate). Outbound sends are always allowed.

## Subcommands

Parse the user's arguments to determine the subcommand:

### `/sms:access list`
Show current DM policy and blocklist from `~/.claude/channels/sms/access.json`.

### `/sms:access block <phone>`
Add a phone number (or wildcard pattern like `+1416*`) to the blocklist.
- Normalize the number to E.164 before saving
- Messages from this number will be stored in the DB for audit but never delivered to Claude Code

### `/sms:access remove <phone>`
Remove a phone number from the blocklist.

### `/sms:access policy <enabled|disabled>`
Set the DM policy:
- `enabled` — any non-blocked number can reach Claude Code (default)
- `disabled` — no inbound messages delivered at all

## File location

`~/.claude/channels/sms/access.json`

## Important

- Always use atomic writes (write to `.tmp`, then rename) via the `writeAccess()` function in `access.ts`
- Re-read the file before every modification to avoid race conditions
- Wildcard patterns use `*` for glob matching on E.164 numbers
