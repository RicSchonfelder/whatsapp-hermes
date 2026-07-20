/**
 * Logger — writes to STDERR only.
 *
 * CRITICAL: This is an MCP stdio server. stdout is reserved exclusively for
 * the MCP JSON-RPC protocol. Any stray byte on stdout corrupts the protocol
 * and breaks the connection to the host. Therefore every log line, warning,
 * error, and the QR code MUST go to stderr.
 */
import pino from "pino";

// pino.destination(2) => file descriptor 2 => stderr
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    base: undefined, // drop pid/hostname noise
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2)
);
