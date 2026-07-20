#!/usr/bin/env node
/**
 * whatsapp-hermes — entrypoint.
 *
 * Boots the WhatsApp (Baileys) client and the MCP stdio server in one process.
 * The MCP host (e.g. Hermes) launches this via `node src/index.js`.
 *
 * Flags:
 *   --pair-only   Start only the WhatsApp client to pair via QR, then exit
 *                 once connected. Useful for first-time setup without a host.
 *
 * REMINDER: stdout is reserved for MCP JSON-RPC. Everything else -> stderr.
 */
import { WhatsAppClient } from "./whatsapp.js";
import { startMcpServer } from "./mcp.js";
import { logger } from "./logger.js";

const pairOnly = process.argv.includes("--pair-only");

async function main() {
  const wa = new WhatsAppClient();
  await wa.start();

  if (pairOnly) {
    logger.info("Pair-only mode: waiting for WhatsApp connection...");
    const interval = setInterval(() => {
      if (wa.status().connected) {
        logger.info("Paired successfully. Session saved to ./wa_auth/. Exiting.");
        clearInterval(interval);
        wa.shutdown().finally(() => process.exit(0));
      }
    }, 1000);
    return;
  }

  await startMcpServer(wa);

  const shutdown = async (sig) => {
    logger.warn(`Received ${sig}, shutting down...`);
    await wa.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.error(`Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
