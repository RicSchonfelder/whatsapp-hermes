/**
 * WhatsApp client built on Baileys (WhatsApp Web protocol).
 *
 * Responsibilities:
 *  - Maintain a persistent socket with auto-reconnect.
 *  - Handle QR-code pairing (QR printed to STDERR).
 *  - Persist multi-file auth state under ./wa_auth/.
 *  - Buffer incoming messages in an in-memory ring buffer.
 *  - Provide send() for outbound messages.
 *
 * All human/diagnostic output goes to STDERR via the logger (stdout is
 * reserved for MCP JSON-RPC).
 */
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { spawn } from "child_process";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(__dirname, "..", "wa_auth");
const CACHE_DIR = join(__dirname, "..", "wa_cache");
const INBOX_DIR = join(CACHE_DIR, "inbox");
const BUFFER_SIZE = parseInt(process.env.WHATSAPP_BUFFER_SIZE || "200", 10);

// Parse the allow-list once.
function parseAllowed() {
  const raw = (process.env.WHATSAPP_ALLOWED_NUMBERS || "").trim();
  if (!raw) return { all: false, set: new Set() };
  if (raw === "*") return { all: true, set: new Set() };
  const set = new Set(
    raw
      .split(",")
      .map((n) => n.replace(/[^0-9]/g, ""))
      .filter(Boolean)
  );
  return { all: false, set };
}

// Strip the device suffix (":12") and non-digits from a JID/number.
function normalizeNumber(jidOrNumber) {
  const beforeAt = String(jidOrNumber).split("@")[0];
  return beforeAt.replace(/:[0-9]+$/, "").replace(/[^0-9]/g, "");
}

// Convert a bare number or JID into a sendable JID.
function toJid(to) {
  if (String(to).includes("@")) return to; // already a JID (user or group)
  const digits = String(to).replace(/[^0-9]/g, "");
  return `${digits}@s.whatsapp.net`;
}

function extractText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

export class WhatsAppClient {
  constructor() {
    this.sock = null;
    this.connected = false;
    this.pairingNeeded = false;
    this.currentQR = "";
    this.selfJid = null;
    this.buffer = []; // ring buffer of incoming messages
    this.chats = new Map(); // chatId -> {chatId, name, isGroup, lastMessage, lastTimestamp}
    this.allowed = parseAllowed();
    this._starting = false;
  }

  async start() {
    if (this._starting) return;
    this._starting = true;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined,
    }));

    this.sock = makeWASocket({
      version,
      auth: state,
      // Baileys wants a pino logger; silence it (we log ourselves to stderr).
      logger: pino({ level: "silent" }),
      printQRInTerminal: false, // we render the QR ourselves, to stderr
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.pairingNeeded = true;
        this.currentQR = qr;
        // Render QR to STDERR so it never touches the MCP stdout channel.
        logger.warn("WhatsApp pairing required — scan this QR code:");
        qrcode.generate(qr, { small: true }, (art) => {
          process.stderr.write("\n" + art + "\n");
        });
      }

      if (connection === "open") {
        this.connected = true;
        this.pairingNeeded = false;
        this.currentQR = "";
        this.selfJid = this.sock.user?.id || null;
        logger.info(`WhatsApp connected as ${this.selfJid}`);
      }

      if (connection === "close") {
        this.connected = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn(
          `WhatsApp connection closed (code=${statusCode}). ${
            loggedOut ? "Logged out — re-pair required." : "Reconnecting..."
          }`
        );
        this._starting = false;
        if (!loggedOut) {
          setTimeout(() => this.start().catch((e) => logger.error(e)), 3000);
        }
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        this._ingest(msg);
      }
    });

    this._starting = false;
  }

  _ingest(msg) {
    try {
      if (!msg.message) return;
      if (msg.key.fromMe) return; // ignore our own outbound

      const chatId = msg.key.remoteJid || "";
      const isGroup = chatId.endsWith("@g.us") || chatId.endsWith("@broadcast");
      // In groups the real sender is in participant; in DMs it's the chatId.
      const senderJid = isGroup ? msg.key.participant || chatId : chatId;
      const senderNum = normalizeNumber(senderJid);

      // Access control (applies to DM sender number).
      if (!this.allowed.all && this.allowed.set.size > 0) {
        if (!this.allowed.set.has(senderNum)) return;
      } else if (!this.allowed.all && this.allowed.set.size === 0) {
        // No allow-list configured: allow but warn once-ish.
        logger.warn(
          "WHATSAPP_ALLOWED_NUMBERS is empty — accepting all senders. Set it in production."
        );
      }

      // Download voice notes / PTT so they can be transcribed later.
      const msgType = Object.keys(msg.message || {}).find((k) =>
        ["audioMessage", "ptvMessage", "ephemeralAudioMessage"].includes(k)
      );
      if (msgType) {
        this._downloadVoice(msg, msgType, senderNum).catch((e) =>
          logger.error(`voice download error: ${e.message}`)
        );
      }

      const text = extractText(msg.message);
      const fromName = msg.pushName || senderNum;
      const timestamp =
        (typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : Number(msg.messageTimestamp)) * 1000 || Date.now();

      const entry = {
        id: msg.key.id,
        from: senderNum,
        fromName,
        chatId,
        isGroup,
        text,
        timestamp,
      };

      this.buffer.push(entry);
      if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

      this.chats.set(chatId, {
        chatId,
        name: fromName,
        isGroup,
        lastMessage: text,
        lastTimestamp: timestamp,
      });
    } catch (e) {
      logger.error(`ingest error: ${e.message}`);
    }
  }

  async _downloadVoice(msg, msgType, senderNum) {
    try {
      if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      const id = msg.key.id || `v${Date.now()}`;
      const file = join(INBOX_DIR, `${senderNum}_${id}.ogg`);
      await writeFile(file, buffer);
      logger.info(`Voice saved: ${file}`);
      // Transcribe asynchronously (does not block ingest).
      const script = join(__dirname, "transcribe_inbox.py");
      if (existsSync(script)) {
        const py = process.env.WHATSAPP_TRANSCRIBE_PY || "python3";
        const p = spawn(py, [script, file], { stdio: "ignore" });
        p.on("error", (e) => logger.error(`transcribe spawn error: ${e.message}`));
      }
    } catch (e) {
      logger.error(`_downloadVoice error: ${e.message}`);
    }
  }

  status() {
    return {
      connected: this.connected,
      pairingNeeded: this.pairingNeeded,
      selfJid: this.selfJid,
      bufferedMessages: this.buffer.length,
    };
  }

  async send(to, message) {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }
    const jid = toJid(to);
    const result = await this.sock.sendMessage(jid, { text: message });
    logger.info(`Sent to ${jid}: ${message.slice(0, 80)}`);
    return { success: true, to: jid, id: result?.key?.id || null };
  }

  async sendImage(to, imagePath, caption) {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }
    let stat;
    try {
      stat = await import("fs").then((fs) => fs.promises.stat(imagePath));
    } catch {
      throw new Error(`Image file not found or unreadable: ${imagePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${imagePath}`);
    }
    const buffer = await readFile(imagePath);
    const jid = toJid(to);
    const result = await this.sock.sendMessage(jid, {
      image: buffer,
      caption: caption || "",
    });
    logger.info(`Image sent to ${jid}: ${imagePath}`);
    return { success: true, to: jid, id: result?.key?.id || null };
  }

  listChats() {
    return Array.from(this.chats.values()).sort(
      (a, b) => b.lastTimestamp - a.lastTimestamp
    );
  }

  getMessages({ chatId, limit = 20, since } = {}) {
    let msgs = this.buffer.slice();
    if (chatId) msgs = msgs.filter((m) => m.chatId === chatId);
    if (since) msgs = msgs.filter((m) => m.timestamp >= since);
    msgs.sort((a, b) => b.timestamp - a.timestamp); // newest first
    return msgs.slice(0, limit);
  }

  async shutdown() {
    try {
      await this.sock?.end?.();
    } catch {
      /* ignore */
    }
  }
}
