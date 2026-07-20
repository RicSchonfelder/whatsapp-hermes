/**
 * MCP server — exposes WhatsApp tools over the stdio transport.
 *
 * stdout = MCP JSON-RPC ONLY. All logs go to stderr (see logger.js).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { logger } from "./logger.js";

const TOOLS = [
  {
    name: "whatsapp_status",
    description:
      "Get the WhatsApp connection status: whether connected, whether pairing (QR scan) is needed, the bot's own JID, and how many messages are buffered.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "whatsapp_send",
    description:
      "Send a WhatsApp text message. 'to' may be a raw phone number (digits, country code, no +) or a full JID (…@s.whatsapp.net for a person, …@g.us for a group).",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Phone number (digits only, with country code) or a full JID.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "whatsapp_list_chats",
    description:
      "List recent chats seen since the server started, newest first, with the last message preview.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "whatsapp_get_messages",
    description:
      "Get buffered incoming messages, newest first. Optionally filter by chatId and/or a 'since' epoch-ms timestamp, and cap with 'limit'.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          description: "Filter to a specific chat JID (from whatsapp_list_chats).",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default 20).",
        },
        since: {
          type: "number",
          description: "Only messages at/after this epoch-ms timestamp.",
        },
      },
      additionalProperties: false,
    },
  },
];

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function err(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * @param {import('./whatsapp.js').WhatsAppClient} wa
 */
export async function startMcpServer(wa) {
  const server = new Server(
    { name: "whatsapp-hermes", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case "whatsapp_status":
          return ok(wa.status());

        case "whatsapp_send": {
          if (!args.to || !args.message)
            return err("Both 'to' and 'message' are required.");
          const res = await wa.send(args.to, args.message);
          return ok(res);
        }

        case "whatsapp_list_chats":
          return ok(wa.listChats());

        case "whatsapp_get_messages":
          return ok(
            wa.getMessages({
              chatId: args.chatId,
              limit: args.limit,
              since: args.since,
            })
          );

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      logger.error(`tool ${name} failed: ${e.message}`);
      return err(e.message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected over stdio.");
  return server;
}
