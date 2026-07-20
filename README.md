# whatsapp-hermes

An **MCP (Model Context Protocol) server** that lets an AI agent — such as
[Hermes Agent](https://hermes-agent.nousresearch.com) — **send and receive
WhatsApp messages**. It connects to WhatsApp through the
[Baileys](https://github.com/WhiskeySockets/Baileys) library (the WhatsApp Web
protocol, paired via QR code), so **no Meta Business API** or developer account
is required.

> ⚠️ **Unofficial API — ban risk.** WhatsApp does not officially support
> third-party clients outside the Business API. Use a **dedicated number**, keep
> usage conversational, and don't send bulk/unsolicited messages.

## Features

- Persistent WhatsApp Web connection with **auto-reconnect**
- **QR-code pairing** (rendered to stderr) with session persisted to `wa_auth/`
- Incoming messages buffered in memory (ring buffer, default 200)
- Sender **allow-list** access control
- Exposed as first-class **MCP tools** over stdio

## MCP Tools

| Tool | Purpose | Params |
|------|---------|--------|
| `whatsapp_status` | Connection + pairing state | — |
| `whatsapp_send` | Send a text message | `to` (number or JID), `message` |
| `whatsapp_list_chats` | Recent chats, newest first | — |
| `whatsapp_get_messages` | Buffered incoming messages | `chatId?`, `limit?` (20), `since?` (epoch ms) |

`to` accepts a raw phone number (digits only, with country code, no `+`) or a
full JID (`<number>@s.whatsapp.net` for a person, `<id>@g.us` for a group).

## Prerequisites

- **Node.js 18+**
- A phone with WhatsApp (to scan the pairing QR)

## Install

```bash
git clone https://github.com/RicSchonfelder/whatsapp-hermes.git
cd whatsapp-hermes
npm install
cp .env.example .env      # then edit .env
```

Set access control in `.env`:

```bash
# Only these numbers may reach the agent (digits, country code, no +):
WHATSAPP_ALLOWED_NUMBERS=5511987654321
# or allow everyone (dev only):
# WHATSAPP_ALLOWED_NUMBERS=*
```

## First-time pairing

Run once to pair, without needing an MCP host:

```bash
npm run pair
```

A QR code prints to the terminal (stderr). On your phone:
**WhatsApp → Settings → Linked Devices → Link a Device**, then scan it. The
session is saved to `wa_auth/` and reused on every subsequent run.

## Register with Hermes

```bash
hermes mcp add whatsapp --command "node" --args "D:/Programas/Whatsapp/src/index.js"
```

On Windows, if `node` isn't resolved from PATH, use the absolute path to the
Node executable:

```bash
hermes mcp add whatsapp --command "C:\\Program Files\\nodejs\\node.exe" --args "D:/Programas/Whatsapp/src/index.js"
```

Then in Hermes, reload MCP servers (`/reload-mcp`) or start a new session. The
`whatsapp_*` tools become available to the agent.

> The server boots the WhatsApp client and the MCP stdio server together.
> On first launch with no saved session it prints a QR to **stderr** and waits
> for pairing; after that it connects silently.

## Protocol note (important)

MCP uses **stdout** for JSON-RPC. This server writes **all** logs and the QR
code to **stderr** — never stdout — so the protocol channel stays clean. If you
extend this project, keep that invariant.

## Security

- `wa_auth/` holds full session credentials — it is git-ignored. **Never commit
  or share it.** Treat it like a password.
- Always set `WHATSAPP_ALLOWED_NUMBERS` before exposing the agent.
- Prefer a dedicated phone number for the bot.

## License

MIT © RicSchonfelder
