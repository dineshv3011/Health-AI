/**
 * logger.js — Persistent Structured Audit Logger
 *
 * Writes NDJSON (newline-delimited JSON) log entries to:
 *   logs/app-YYYY-MM-DD.log     — daily rotating application log
 *   logs/audit-YYYY-MM-DD.log   — separate security/audit trail
 *
 * Each entry is a single JSON line with no PII from message content.
 *
 * Usage:
 *   const logger = require("./logger");
 *   logger.info(req, "chat_request", { usedAI: true });
 *   logger.warn(req, "rate_limited", { ip: "..." });
 *   logger.error(req, "groq_failure", { err: err.message });
 *   logger.audit(req, "login_success", { userId: "admin-001", role: "admin" });
 *   logger.audit(req, "login_failure", { username: "unknown" });
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateSuffix() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getStream(prefix) {
  const file = path.join(LOG_DIR, `${prefix}-${dateSuffix()}.log`);
  // Append mode — safe to reuse across requests (Node buffers writes)
  return fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
}

function safeIp(req) {
  return (req && req.socket && req.socket.remoteAddress) || "unknown";
}

function entry(level, req, event, extra = {}) {
  return JSON.stringify({
    ts:     new Date().toISOString(),
    level,
    event,
    method: req ? req.method  : undefined,
    path:   req ? req.path    : undefined,
    ip:     safeIp(req),
    userId: req && req.user ? req.user.sub  : undefined,
    role:   req && req.user ? req.user.role : undefined,
    ...extra,
  }) + "\n";
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function write(prefix, line) {
  const stream = getStream(prefix);
  stream.write(line);
  stream.end();
  // Also echo to stdout in development
  if (process.env.NODE_ENV !== "production") {
    process.stdout.write(line);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function info(req, event, extra)  { write("app",   entry("INFO",  req, event, extra)); }
function warn(req, event, extra)  { write("app",   entry("WARN",  req, event, extra)); }
function error(req, event, extra) { write("app",   entry("ERROR", req, event, extra)); }

/** Security-relevant events go to the separate audit log */
function audit(req, event, extra) {
  const line = entry("AUDIT", req, event, extra);
  write("audit", line);
  write("app",   line); // also mirror to app log for unified search
}

/** Express request logger middleware — call after routes */
function requestMiddleware() {
  return (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const level = res.statusCode >= 500 ? "ERROR"
                  : res.statusCode >= 400 ? "WARN"
                  : "INFO";
      write("app", entry(level, req, "http_response", {
        status:  res.statusCode,
        ms:      Date.now() - start,
      }));
    });
    next();
  };
}

module.exports = { info, warn, error, audit, requestMiddleware };
