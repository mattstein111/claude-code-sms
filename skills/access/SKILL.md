---
name: sms:access
description: Manage the SMS channel phone allowlist, blocklist, and pairing approvals
user_invocable: true
---

# /sms:access

Manage phone number access for the SMS channel plugin.

## Subcommands

Parse the user's arguments to determine the subcommand:

### `/sms:access list`
Show current access policy, allowlist, and blocklist from `~/.claude/channels/sms/access.json`.

### `/sms:access allow <phone>`
Add a phone number (or wildcard pattern like `+1416*`) to the allowlist.
- Normalize the number to E.164 before saving
- Check it's not already in the list
- Remove from blocklist if present

### `/sms:access block <phone>`
Add a phone number (or wildcard pattern) to the blocklist.
- Normalize the number to E.164 before saving
- Remove from allowlist if present
- Messages from this number will be stored in the DB for audit but never delivered to Claude Code

### `/sms:access remove <phone>`
Remove a phone number from both allowlist and blocklist.

### `/sms:access policy <allowlist|disabled>`
Set the DM policy:
- `allowlist` — only allowlisted numbers (and the owner) can reach Claude Code
- `disabled` — no inbound messages delivered at all

### `/sms:access pair <code>`
Approve a pending pairing request. When an unknown number texts in:
1. The MCP server generates a 6-char hex code and replies via SMS
2. The user runs `/sms:access pair <code>` in their terminal
3. This writes an approval file to `~/.claude/channels/sms/approved/<phone>`
4. The MCP server detects the approval, confirms via SMS, and adds to allowlist

## File location

`~/.claude/channels/sms/access.json`

## Important

- Always use atomic writes (write to `.tmp`, then rename) via the `writeAccess()` function in `access.ts`
- Re-read the file before every modification to avoid race conditions
- Wildcard patterns use `*` for glob matching on E.164 numbers
