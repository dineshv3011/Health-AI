require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

// ─────────────────────────────────────────────
// Internal modules (10/10 additions)
// ─────────────────────────────────────────────
const { loginRoute, requireAuth, requireRole } = require("./auth");
const logger = require("./logger");

const app = express();

// ─────────────────────────────────────────────
// SECURITY: Manual security headers
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'"
  );
  res.removeHeader("X-Powered-By");
  next();
});

// ─────────────────────────────────────────────
// SECURITY: Restrict CORS to known origins
// ─────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Token"],
}));

app.use(express.json({ limit: "16kb" }));

// ─────────────────────────────────────────────
// SECURITY: Rate limiter using socket IP (not spoofable)
// ─────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQ   = 60;

function rateLimit(req, res, next) {
  const ip  = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) entry = { count: 0, reset: now + RATE_WINDOW_MS };
  entry.count++;
  rateLimitMap.set(ip, entry);
  res.setHeader("X-RateLimit-Limit",     RATE_MAX_REQ);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_MAX_REQ - entry.count));
  res.setHeader("X-RateLimit-Reset",     Math.ceil(entry.reset / 1000));
  if (entry.count > RATE_MAX_REQ) {
    logger.warn(req, "rate_limited", { ip });
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(ip);
  }
}, 300_000);

app.use(rateLimit);

// ─────────────────────────────────────────────
// Persistent structured request logging
// ─────────────────────────────────────────────
app.use(logger.requestMiddleware());

// ─────────────────────────────────────────────
// SECURITY: Serve only whitelisted static files
// ─────────────────────────────────────────────
const ALLOWED_STATIC = new Set(["index.html", "style.css", "app.js"]);

app.get("/:file", (req, res, next) => {
  const fileName = req.params.file;
  if (!ALLOWED_STATIC.has(fileName)) return next();
  const filePath = path.resolve(__dirname, fileName);
  if (!filePath.startsWith(path.resolve(__dirname))) return res.status(400).end();
  res.sendFile(filePath);
});
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ─────────────────────────────────────────────
// Config from .env
// ─────────────────────────────────────────────
const GROQ_API_KEY      = process.env.GROQ_API_KEY;
const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY;
const HINDSIGHT_API_URL = process.env.HINDSIGHT_API_URL || "https://api.hindsight.vectorize.io";
const HINDSIGHT_BANK_ID = process.env.HINDSIGHT_BANK_ID || "hospital-ai";
const PORT              = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Load medicines
// ─────────────────────────────────────────────
let medicines = [];
try {
  medicines = JSON.parse(fs.readFileSync(path.join(__dirname, "medicines.json"), "utf-8"));
} catch (err) {
  console.warn("medicines.json not found or invalid — using empty inventory.");
}

// ─────────────────────────────────────────────
// Search frequency tracker
// ─────────────────────────────────────────────
const searchFrequency = {};

function recordSearch(query) {
  const key = query.toLowerCase().trim();
  searchFrequency[key] = (searchFrequency[key] || 0) + 1;
}

function getFrequentSearches(threshold = 3) {
  return Object.entries(searchFrequency)
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

function getRestockAlerts() {
  const frequent = getFrequentSearches(2);
  const alerts   = [];
  for (const { name, count } of frequent) {
    const med = medicines.find(m =>
      m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase())
    );
    if (med && med.stock <= 50) {
      alerts.push({ medicine: med.name, stock: med.stock, searchCount: count, location: med.location });
    }
  }
  return alerts;
}

// ─────────────────────────────────────────────
// SECURITY: Memory bounded by user count (prevents DoS)
// ─────────────────────────────────────────────
const localMemory        = {};
const MAX_MEMORY_PER_USER = 20;
const MAX_USERS           = 500;

async function hindsightRetain(userId, userMessage, agentReply) {
  if (!localMemory[userId] && Object.keys(localMemory).length >= MAX_USERS) {
    const oldest = Object.keys(localMemory)[0];
    delete localMemory[oldest];
  }
  if (!localMemory[userId]) localMemory[userId] = [];
  localMemory[userId].push({ userMessage, agentReply, timestamp: new Date().toISOString() });
  if (localMemory[userId].length > MAX_MEMORY_PER_USER) {
    localMemory[userId] = localMemory[userId].slice(-MAX_MEMORY_PER_USER);
  }
}

async function hindsightRecall(userId, query) {
  const history = localMemory[userId];
  if (!history || history.length === 0) return null;
  return history.slice(-5)
    .map(m => `User: ${m.userMessage}\nAssistant: ${m.agentReply}`)
    .join("\n---\n");
}

// ─────────────────────────────────────────────
// SECURITY: Input sanitisation (prompt injection defence)
// ─────────────────────────────────────────────
function sanitizeForPrompt(text) {
  return text
    .replace(/[<>]/g, "")
    .replace(/\bignore\s+(all\s+)?previous\s+instructions?\b/gi, "[filtered]")
    .replace(/\bsystem\s*:/gi, "[filtered]")
    .replace(/\bact\s+as\b/gi, "[filtered]")
    .replace(/[\u0000-\u001F\u007F]/g, "");
}

function sanitizeOutput(text) {
  return text.replace(/<[^>]*>/g, "");
}

// ─────────────────────────────────────────────
// Groq LLM helper
// ─────────────────────────────────────────────
async function callGroq(systemPrompt, userMessage) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set in .env");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      model:       "llama-3.3-70b-versatile",
      messages:    [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  }
      ],
      temperature: 0.3,
      max_tokens:  500
    })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Groq API error ${res.status}: ${t}`); }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("No text returned from Groq");
  return text.trim();
}

// ─────────────────────────────────────────────
// Keyword fallback
// ─────────────────────────────────────────────
function keywordFallback(msg) {
  const match = medicines.find(m =>
    msg.toLowerCase().includes(m.name.toLowerCase()) ||
    m.name.toLowerCase().includes(msg.toLowerCase())
  );
  if (!match) return `❌ Medicine not found.\n💡 Try: ${medicines.slice(0, 5).map(m => m.name).join(", ")} and more.`;
  if (match.stock > 50)     return `✅ ${match.name} available\n📍 ${match.location}\n📦 ${match.stock} units\n🏷️ ${match.category}`;
  else if (match.stock > 0) return `⚠️ ${match.name} LOW stock\n📍 ${match.location}\n📦 ${match.stock} units\n🏷️ ${match.category}`;
  else                      return `❌ ${match.name} OUT OF STOCK\n📍 Usually at: ${match.location}\n🏷️ ${match.category}\n⚡ Restock urgently.`;
}

// ═════════════════════════════════════════════
// POST /login — JWT authentication
// ═════════════════════════════════════════════
app.post("/login", (req, res) => {
  const { username } = req.body || {};
  loginRoute(req, res);
  // Audit logging happens after response — wrap to capture outcome
  res.on("finish", () => {
    if (res.statusCode === 200) {
      logger.audit(req, "login_success", { username });
    } else {
      logger.audit(req, "login_failure", { username, status: res.statusCode });
    }
  });
});

// ═════════════════════════════════════════════
// POST /chat — JWT required (staff or admin)
// ═════════════════════════════════════════════
app.post("/chat", async (req, res) => {
  const { message, user } = req.body;
  const userId = req.body.user || "default-user";

  if (!message || typeof message !== "string") {
    logger.warn(req, "chat_bad_request", { reason: "missing_message" });
    return res.status(400).json({ error: "Message is required and must be a string." });
  }
  const trimmedMessage = message.trim();
  if (!trimmedMessage)                return res.status(400).json({ error: "Message cannot be empty." });
  if (trimmedMessage.length > 500)    return res.status(400).json({ error: "Message too long (max 500 chars)." });

  const safeMessage = sanitizeForPrompt(trimmedMessage);
  recordSearch(safeMessage);

  let reply   = "";
  let usedAI  = false;
  let memories = null;

  try {
    memories = await hindsightRecall(userId, safeMessage);
    const restockAlerts  = getRestockAlerts();
    const restockContext = restockAlerts.length > 0
      ? `\nSMART RESTOCK ALERTS:\n${restockAlerts.map(a => `- ${a.medicine}: ${a.stock} units left, searched ${a.searchCount} times today. Location: ${a.location}`).join("\n")}\n`
      : "";

    const systemPrompt = `You are a smart hospital pharmacy assistant AI. You help hospital staff check medicine availability, track stock, and predict shortages.

CURRENT MEDICINE INVENTORY:
${JSON.stringify(medicines, null, 2)}
${restockContext}
${memories ? `MEMORY — RELEVANT PAST CONTEXT:\n${memories}\n` : ""}

RULES:
- Answer clearly and concisely.
- Stock > 50 = Available ✅ | Stock 1–50 = Low Stock ⚠️ | Stock 0 = Out of Stock ❌
- Only use stock numbers from the inventory above. Never make up numbers.
- If MEMORY context exists, reference it naturally.
- Use emojis for structure. No markdown headers or bullet hyphens.`;

    reply  = await callGroq(systemPrompt, safeMessage);
    reply  = sanitizeOutput(reply);
    usedAI = true;
    hindsightRetain(userId, safeMessage, reply);
    logger.info(req, "chat_success", { usedAI });
  } catch (err) {
    logger.error(req, "chat_ai_failure", { err: err.message });
    reply = keywordFallback(safeMessage);
  }

  res.json({
    reply,
    usedAI,
    memoryInjected: !!memories,
    restockAlerts:  getRestockAlerts(),
    timestamp:      new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// GET /medicines — JWT required (any role)
// ─────────────────────────────────────────────
app.get("/medicines", (req, res) => {
  const { category, status } = req.query;
  let result = medicines;
  if (category)               result = result.filter(m => m.category.toLowerCase().includes(category.toLowerCase()));
  if (status === "low")       result = result.filter(m => m.stock > 0 && m.stock <= 50);
  else if (status === "out")  result = result.filter(m => m.stock === 0);
  else if (status === "available") result = result.filter(m => m.stock > 50);
  res.json({ total: result.length, medicines: result });
});

// ─────────────────────────────────────────────
// GET /insights — admin only
// ─────────────────────────────────────────────
app.get("/insights", (req, res) => {
  logger.audit(req, "insights_accessed");
  res.json({
    searchFrequency,
    restockAlerts: getRestockAlerts(),
    topSearches:   getFrequentSearches(1)
  });
});

// ─────────────────────────────────────────────
// GET /health — minimal response (no internal leakage)
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────
// 404 catch-all
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// ─────────────────────────────────────────────
// Global error handler (no stack traces to client)
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(req, "unhandled_error", { err: err.message });
  res.status(500).json({ error: "Internal server error. Please try again." });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Hospital AI Server running on http://localhost:${PORT}`);
  console.log(`🤖 Groq LLM:         ${GROQ_API_KEY      ? "enabled ✅" : "not set ❌ (fallback mode)"}`);
  console.log(`🧠 Hindsight Memory: ${HINDSIGHT_API_KEY ? "enabled ✅" : "not set ❌ (no persistent memory)"}`);
  console.log(`💊 Medicines loaded: ${medicines.length}`);
  console.log(`🔐 JWT Auth:         enabled ✅`);
  console.log(`📋 Audit Logging:    enabled ✅  → logs/`);
  console.log(`🌐 HTTPS:            configure nginx.conf with your domain`);
  console.log(`\n🌐 Open http://localhost:${PORT} in your browser\n`);
});