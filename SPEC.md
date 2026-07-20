# Whatsapp-Hermes — MCP Connector Specification

## Goal
Build a **Model Context Protocol (MCP) server** in **Node.js** that lets an AI agent (Hermes)
send and receive WhatsApp messages. It connects to WhatsApp via the Baileys library
(WhatsApp Web protocol, QR-code pairing, no Meta Business API).

This is a fresh, standalone, public open-source project. Runtime: **Node.js (ESM)**.

## Tech stack
- Node.js 18+ (ESM modules, `"type": "module"`)
- `@modelcontextprotocol/sdk` — the official MCP TypeScript/JS SDK (server over stdio transport)
- `@whiskeysockets/baileys` `^7.0.0-rc13` — WhatsApp Web client
- `qrcode-terminal` — render the pairing QR in the terminal
- `pino` — logging (Baileys uses pino)

## Architecture
Two responsibilities in one process:
1. **WhatsApp client (Baileys):** maintains a persistent socket, handles QR pairing,
   auto-reconnect, and multi-file auth state saved to `./wa_auth/`.
   - Incoming messages are pushed into an in-memory ring buffer (keep last N=200),
     each stored as `{ id, from, fromName, chatId, isGroup, text, timestamp }`.
   - Text extraction should handle `conversation` and `extendedTextMessage` message types.
2. **MCP server (stdio):** exposes tools the agent can call.

## MCP tools to expose
- `whatsapp_status` — returns `{ connected, pairingNeeded, selfJid }`.
- `whatsapp_send` — params `{ to: string, message: string }`. `to` may be a raw phone
  number (digits, country code, no +) OR a full JID (`...@s.whatsapp.net` / `...@g.us`).
  Normalize a bare number to `<number>@s.whatsapp.net`. Returns `{ success, to, id }`.
- `whatsapp_list_chats` — returns recent distinct chats seen in the buffer:
  `[{ chatId, name, isGroup, lastMessage, lastTimestamp }]`.
- `whatsapp_get_messages` — params `{ chatId?: string, limit?: number (default 20), since?: number(ms epoch) }`.
  Returns messages from the buffer, newest first, optionally filtered by chat/since.
- `whatsapp_mark_read` — optional, params `{ chatId }` — clears unread markers if tracked.

## Access control
- Env var `WHATSAPP_ALLOWED_NUMBERS` = comma-separated numbers (digits only, no +).
  If set, only messages from these numbers enter the buffer. If `*` or unset in dev,
  allow all but log a warning.
- Never expose or log full auth credentials.

## Files / layout
```
Whatsapp/
├── package.json
├── README.md              # setup, pairing, MCP registration with Hermes, tool list
├── LICENSE                # MIT, author RicSchonfelder
├── .gitignore             # node_modules, wa_auth/, *.log, .env
├── .env.example           # WHATSAPP_ALLOWED_NUMBERS=
├── src/
│   ├── index.js           # entrypoint: boots WhatsApp client + MCP server
│   ├── whatsapp.js        # Baileys client, buffer, send/receive
│   ├── mcp.js             # MCP server, tool registration/dispatch
│   └── logger.js          # pino logger
```

## MCP transport
Use **stdio** transport (standard for local MCP servers spawned by a host).
The MCP host launches `node src/index.js`. On first run with no saved auth,
print the QR code to **stderr** (so it doesn't corrupt the stdio JSON-RPC on stdout)
and wait for pairing. Pairing state persists in `wa_auth/` so subsequent runs are silent.

IMPORTANT: MCP JSON-RPC uses **stdout** — all logs, QR codes, and human output MUST go to
**stderr**, never stdout. This is critical or the MCP protocol breaks.

## Quality
- Clean, commented ESM code.
- Graceful shutdown (SIGINT/SIGTERM close the socket).
- Auto-reconnect on disconnect unless logged out (DisconnectReason.loggedOut).
- A `README.md` with: prerequisites, `npm install`, first-run pairing, how to add to
  Hermes via `hermes mcp add whatsapp --command "node D:/Programas/Whatsapp/src/index.js"`,
  and a table of the MCP tools.

## Do NOT
- Do not use the official WhatsApp Business/Cloud API.
- Do not write anything to stdout except MCP JSON-RPC.
- Do not commit wa_auth/ or .env.
