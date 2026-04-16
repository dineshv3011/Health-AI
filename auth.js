/**
 * auth.js — JWT Authentication Middleware
 * Provides login endpoint + route protection for hospital staff roles.
 *
 * Roles:
 *   admin   — full access (/insights, /chat, /medicines)
 *   staff   — /chat and /medicines only
 *   viewer  — /medicines read-only
 *
 * Usage in server.js:
 *   const { loginRoute, requireAuth, requireRole } = require("./auth");
 *   app.post("/login", loginRoute);
 *   app.post("/chat", requireAuth, requireRole("staff", "admin"), handler);
 */

"use strict";

const crypto = require("crypto");

// ── JWT secret from env (MUST be set in production) ──────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn("⚠️  JWT_SECRET not set — using a random ephemeral secret. Set JWT_SECRET in .env!");
  return crypto.randomBytes(64).toString("hex");
})();

const JWT_EXPIRES_SECONDS = parseInt(process.env.JWT_EXPIRES_SECONDS || "3600", 10); // 1 hour default

// ── Staff user store ──────────────────────────────────────────────────────────
// In production, replace with a database lookup + bcrypt password verification.
// Passwords here are SHA-256 hashes: node -e "console.log(require('crypto').createHash('sha256').update('yourpassword').digest('hex'))"
const STAFF_USERS = (() => {
  try {
    return JSON.parse(process.env.STAFF_USERS || "null") || defaultUsers();
  } catch {
    return defaultUsers();
  }
})();

function defaultUsers() {
  return [
    {
      id:       "admin-001",
      username: "admin",
      // Default password: "admin123" — CHANGE THIS in production via STAFF_USERS env var
      passwordHash: crypto.createHash("sha256").update("admin123").digest("hex"),
      role:     "admin",
      name:     "Hospital Administrator",
    },
    {
      id:       "staff-001",
      username: "nurse",
      // Default password: "nurse123" — CHANGE THIS in production
      passwordHash: crypto.createHash("sha256").update("nurse123").digest("hex"),
      role:     "staff",
      name:     "Nursing Staff",
    },
    {
      id:       "viewer-001",
      username: "viewer",
      // Default password: "view123" — CHANGE THIS in production
      passwordHash: crypto.createHash("sha256").update("view123").digest("hex"),
      role:     "viewer",
      name:     "Read-Only Viewer",
    },
  ];
}

// ── Minimal JWT implementation (no external deps) ────────────────────────────

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str) {
  const padded = str + "===".slice((str.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signJWT(payload) {
  const header  = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body    = base64urlEncode(JSON.stringify(payload));
  const sig     = base64urlEncode(
    crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = base64urlEncode(
    crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest()
  );
  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(base64urlDecode(body).toString("utf8"));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

// ── Login route handler ───────────────────────────────────────────────────────

function loginRoute(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "username and password are required." });
  }

  const user = STAFF_USERS.find(u => u.username === username.trim().toLowerCase());
  if (!user) {
    // Constant-time dummy comparison to prevent user-enumeration via timing
    crypto.timingSafeEqual(
      Buffer.alloc(32),
      crypto.createHash("sha256").update(password).digest()
    );
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const hash = crypto.createHash("sha256").update(password).digest();
  const expected = Buffer.from(user.passwordHash, "hex");
  if (!crypto.timingSafeEqual(hash, expected)) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub:  user.id,
    name: user.name,
    role: user.role,
    iat:  now,
    exp:  now + JWT_EXPIRES_SECONDS,
  };

  const token = signJWT(payload);

  res.json({
    token,
    expiresIn: JWT_EXPIRES_SECONDS,
    user: { id: user.id, name: user.name, role: user.role },
  });
}

// ── requireAuth middleware ────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  let token = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.headers["x-api-token"]) {
    // Backward-compat with the old token header
    token = req.headers["x-api-token"];
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required. Send: Authorization: Bearer <token>" });
  }

  const payload = verifyJWT(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }

  req.user = payload; // attach to request for downstream handlers
  next();
}

// ── requireRole middleware factory ────────────────────────────────────────────

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated." });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(" or ")}.`,
        yourRole: req.user.role,
      });
    }
    next();
  };
}

module.exports = { loginRoute, requireAuth, requireRole, verifyJWT };
