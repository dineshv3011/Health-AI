# Hospital AI 

AI-powered hospital pharmacy assistant with full security hardening.

## Security Checklist

| # | Vulnerability | Fix | Status |
|---|--------------|-----|--------|
| 1 | `.env` / `server.js` exposed via static server | Whitelist-only static file server | ✅ Fixed |
| 2 | No security headers | X-Frame, CSP, XSS, HSTS, Referrer | ✅ Fixed |
| 3 | CORS `*` wildcard | Origin allowlist from `.env` | ✅ Fixed |
| 4 | Prompt injection | `sanitizeForPrompt()` filter | ✅ Fixed |
| 5 | `searchFrequency` leaked to all clients | Removed from `/chat` response | ✅ Fixed |
| 6 | Rate limiter spoofable via `req.ip` | Uses `req.socket.remoteAddress` | ✅ Fixed |
| 7 | `localMemory` unbounded DoS | Capped at 500 users × 20 msgs | ✅ Fixed |
| 8 | `/health` leaked internal state | Returns only `{ status: "ok" }` | ✅ Fixed |
| 9 | **No HTTPS** | `nginx.conf` reverse proxy + Let's Encrypt | ✅ Added |
| 10 | **No authentication** | JWT login with role-based access control | ✅ Added |
| 11 | **No audit logging** | Persistent NDJSON logs in `logs/` | ✅ Added |

## Files

```
Hospital-Ai/
├── server.js       ← Backend API (hardened)
├── auth.js         ← JWT auth + RBAC middleware  ← NEW
├── logger.js       ← Persistent audit logging    ← NEW
├── nginx.conf      ← HTTPS reverse proxy config  ← NEW
├── logs/           ← Created at runtime          ← NEW
├── index.html      ← Frontend HTML
├── style.css       ← Frontend styles
├── app.js          ← Frontend JS
├── medicines.json  ← Medicine inventory
├── .env            ← Config (never commit)
└── package.json    ← Dependencies
```

## How to Run (Development)

```bash
cd "it's location"
npm install
cp .env .env.local    # edit .env.local with your real keys
node server.js
```
Open `http://localhost:3000` — you'll need to **log in** first.

## Default Credentials (CHANGE BEFORE DEPLOYING)

| Username | Password   | Role   | Access |
|----------|-----------|--------|--------|
| admin    | admin123  | admin  | All endpoints including /insights |
| nurse    | nurse123  | staff  | /chat and /medicines |
| viewer   | view123   | viewer | /medicines read-only |

Change passwords via the `STAFF_USERS` env variable (see `.env`).

## API Endpoints

| Method | Route       | Auth Required | Role          | Description |
|--------|-------------|---------------|---------------|-------------|
| POST   | `/login`    | No            | —             | Get JWT token |
| POST   | `/chat`     | ✅ JWT        | staff / admin | AI pharmacy chat |
| GET    | `/medicines`| ✅ JWT        | any           | List medicines |
| GET    | `/insights` | ✅ JWT        | admin only    | Search analytics |
| GET    | `/health`   | No            | —             | Server health |

### Login Example

```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"nurse","password":"nurse123"}'
# Returns: { "token": "eyJ...", "expiresIn": 3600, "user": {...} }

curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJ..." \
  -d '{"message":"Is paracetamol available?"}'
```

## Production Deployment (HTTPS)

1. Install Nginx and Certbot:
   ```bash
   sudo apt install nginx certbot python3-certbot-nginx
   ```
2. Copy `nginx.conf` to `/etc/nginx/sites-available/hospital-ai`
3. Replace `yourhospital.com` with your domain
4. Enable the site and get a certificate:
   ```bash
   sudo ln -s /etc/nginx/sites-available/hospital-ai /etc/nginx/sites-enabled/
   sudo certbot --nginx -d yourhospital.com
   sudo systemctl reload nginx
   ```
5. Set `ALLOWED_ORIGINS=https://yourhospital.com` in `.env`
6. Set a strong `JWT_SECRET` (64+ random bytes)
7. Set production `STAFF_USERS` with hashed passwords

## Audit Logs

Logs are written to `logs/` in NDJSON format:
- `logs/app-YYYY-MM-DD.log` — all HTTP requests + errors
- `logs/audit-YYYY-MM-DD.log` — login events, admin access

Each entry: `{ ts, level, event, method, path, ip, userId, role, ... }`
