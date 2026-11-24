npm # G Coin Rewards

Earn **G Coins**, share rewards with friends, and redeem coins for vouchers and perks. A full-stack web app:

- **Backend:** Node.js 18.18+ / Express 4 / MongoDB (Mongoose)
- **Frontend:** dependency-free single-page apps (vanilla JS, no build step) for the customer panel (`/`) and the admin panel (`/admin/`)
- **Auth:** Google OAuth 2.0 (customers), bcrypt-hashed credentials + optional TOTP MFA (admins)
- **Chatbot:** provider-agnostic (Anthropic, OpenAI-compatible, Gemini) with a rule-based fallback

Everything is configured through environment variables. ngrok is supported for local testing and never required in production.

---

## Contents

1. [Quick start (local)](#1-quick-start-local)
2. [MongoDB setup](#2-mongodb-setup)
3. [Google OAuth setup](#3-google-oauth-setup)
4. [Create the first admin (securely)](#4-create-the-first-admin-securely)
5. [AI chatbot setup](#5-ai-chatbot-setup)
6. [Testing with ngrok](#6-testing-with-ngrok)
7. [Production deployment](#7-production-deployment)
8. [Running the tests](#8-running-the-tests)
9. [How the rules work](#9-how-the-rules-work)
10. [Security design](#10-security-design)
11. [Project layout and API overview](#11-project-layout-and-api-overview)
12. [Known limitations](#12-known-limitations)

---

## 1. Quick start (local)

```bash
npm install
cp .env.example .env
npm run gen-secrets          # paste SESSION_SECRET and DATA_ENCRYPTION_KEY into .env
# start MongoDB (see section 2), then:
npm run seed                 # example rewards + fake DEMO-... voucher codes
npm run create-admin         # interactive; see section 4
npm run dev                  # http://localhost:3000   (admin: /admin/)
```

For a first look **without Google credentials**, set `ENABLE_DEV_LOGIN=true` in `.env`. The login page then shows a "Developer sign-in" form. This is local-only: the server refuses to start with it enabled in production.

Useful scripts:

| Command | What it does |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-restart on file changes |
| `npm run seed` | Create example rewards and demo voucher codes (idempotent). `-- --reset` removes seeded data first |
| `npm run create-admin` | Create an admin account (`-- --role viewer\|admin\|superadmin`, `-- --mfa`) |
| `npm run gen-secrets` | Print fresh random secrets (nothing is written to disk) |
| `npm test` | Run the test suite (needs MongoDB, see section 8) |

---

## 2. MongoDB setup

Pick one:

**A. Docker (easiest locally)**
```bash
docker compose up -d mongo      # MongoDB 7 on 127.0.0.1:27017
# .env: MONGODB_URI=mongodb://127.0.0.1:27017/gcoin
```

**B. Installed locally** – install MongoDB Community 6+ and run `mongod`. Use `MONGODB_URI=mongodb://127.0.0.1:27017/gcoin`.

**C. MongoDB Atlas (recommended for production)**
1. Create a cluster, then a database user with read/write access to one database.
2. Network Access: allow your server's outbound IPs (avoid `0.0.0.0/0` in production).
3. Copy the connection string into `MONGODB_URI` (`mongodb+srv://...`).

The app creates all collections and indexes on startup. It does **not** need a replica set or multi-document transactions: every money-moving step is a single-document atomic update (see [How the rules work](#9-how-the-rules-work)), so it behaves the same on a standalone `mongod`, a replica set, or Atlas.

Connection pooling is configured with `MONGO_MAX_POOL_SIZE` / `MONGO_MIN_POOL_SIZE`.

---

## 3. Google OAuth setup

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → OAuth consent screen:** choose *External*, fill in app name and support email. Scopes needed: `openid`, `email`, `profile` (all non-sensitive). While in *Testing* mode, add your test Gmail accounts as test users.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**.
4. **Authorized redirect URIs** (must match exactly, including scheme and no trailing slash):
   - Local: `http://localhost:3000/api/auth/google/callback`
   - ngrok: `https://<your-subdomain>.ngrok-free.app/api/auth/google/callback`
   - Production: `https://rewards.example.com/api/auth/google/callback`
5. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set `PUBLIC_URL` to the same origin you used in the redirect URI.

How sign-in works: the server redirects to Google with a random `state` and a PKCE challenge; on return it validates `state`, exchanges the code with the PKCE verifier, verifies the ID token's signature and audience, and **requires `email_verified: true`**. It stores only Google's account id (`sub`), verified email, name and picture URL. No password is ever requested or stored. A new session ID is issued on login (prevents session fixation).

---

## 4. Create the first admin (securely)

There is deliberately **no public admin signup and no shared secret code**. Admin accounts are created from the server's command line, which means only someone with access to the deployment and its database credentials can create one.

```bash
npm run create-admin -- --role superadmin --mfa
```

- You are prompted for email, name and a password (typed hidden, entered twice). Minimum 12 characters with at least three of: lowercase, uppercase, digits, symbols.
- The password is hashed with **bcrypt (cost 12)**; the plaintext is never stored or logged.
- With `--mfa`, a TOTP secret is generated and shown **once** as a QR code in the terminal. Scan it with Google Authenticator, Authy, 1Password, etc. Without `--mfa`, sign in and enable MFA under **Admin → Security**.
- For automated provisioning, set `ADMIN_EMAIL`, `ADMIN_NAME` and `ADMIN_PASSWORD` in the environment of that one command only, never in a committed file, then clear your shell history.

Recommended practice:
- Use `ADMIN_REQUIRE_MFA=true` in production so no admin can use the panel without MFA.
- Create one **superadmin** for yourself and give colleagues `admin` (manage rewards/vouchers) or `viewer` (read-only).
- Roles: **viewer** reads everything; **admin** also creates/edits/activates rewards and adds voucher codes; **superadmin** additionally removes rewards and deletes voucher codes.

Built-in protections: account lockout after repeated failures (`ADMIN_MAX_FAILED_LOGINS`, `ADMIN_LOCK_MINUTES`), per-IP rate limiting, generic error messages (no user enumeration), idle (`ADMIN_IDLE_MINUTES`) and absolute (`ADMIN_ABSOLUTE_HOURS`) session timeouts, a separate session cookie scoped to `/api/admin`, and authorization re-checked against the database on **every** request, so disabling or demoting an admin takes effect immediately.

**Sensitive actions** (removing a reward, deleting a voucher code, disabling MFA) require the admin to **re-enter their password (and a fresh authenticator code if MFA is on)** in addition to a confirmation dialog. Every important action is written to the audit log.

---

## 5. AI chatbot setup

The assistant answers questions about G Coins, rules, prices, availability, sharing, redemptions and vouchers. It works **without any AI key** using a built-in rule-based responder; adding a key upgrades answers to a language model.

```env
CHATBOT_ENABLED=true
AI_PROVIDER=anthropic          # anthropic | openai | gemini
AI_API_KEY=your-provider-key
AI_MODEL=                      # optional; sensible default per provider
```

| Provider | Where to get a key | Notes |
|---|---|---|
| `anthropic` | <https://console.anthropic.com/> | Default model `claude-haiku-5-5` |
| `openai` | <https://platform.openai.com/> | Default `gpt-4o-mini`. Also works with any OpenAI-compatible API (OpenRouter, Groq, local Ollama…) via `AI_BASE_URL` |
| `gemini` | <https://aistudio.google.com/> | Default `gemini-2.0-flash` |

Set `CHATBOT_ENABLED=false` to remove the assistant from both the UI and the API.

What the assistant can and cannot do:
- **Grounded:** each request loads the current active rewards (name, price, availability, details) and the live sharing rules from the database/config. Nothing about the catalog is hard-coded in the prompt.
- **Account questions** (balance, history, redemptions, "what can I afford?") require sign-in, checked server-side from the session. Only the signed-in user's own minimal summary (balance + last 5 transactions/redemptions) is provided.
- **No tools / no side effects:** the model only produces text. It cannot redeem, change balances, reveal voucher codes or call admin endpoints; there is no code path from a model reply to any of those.
- **Privacy:** the provider never receives passwords, session cookies, CSRF tokens, emails, names, Google ids or voucher codes. The API key is only attached server-side.
- **Abuse limits:** per-user/IP rate limit (`CHAT_RATE_LIMIT_PER_MIN`), a daily cap (`CHAT_DAILY_LIMIT`), input length limit (`CHAT_MAX_INPUT_CHARS`), short history, and request timeout.
- **Failure handling:** if the provider is not configured, times out or errors, the user gets a rule-based answer labelled "Automated answer (AI unavailable)". Provider errors are never shown to users.
- **Labelling:** model replies are tagged "AI-generated" and the panel shows a notice that answers can be wrong.

---

## 6. Testing with ngrok

Use ngrok to try Google sign-in or share links from your phone while developing locally.

```bash
npm run dev                      # app on :3000
ngrok http 3000                  # note the https URL, e.g. https://abc123.ngrok-free.app
```

Then in `.env`:

```env
PUBLIC_URL=https://abc123.ngrok-free.app
TRUST_PROXY=1
```

1. Add `https://abc123.ngrok-free.app/api/auth/google/callback` to the OAuth client's **Authorized redirect URIs**.
2. Restart `npm run dev` and open the ngrok URL (not `localhost`) so cookies and redirects share one origin.
3. Free ngrok URLs change on every restart; update `PUBLIC_URL` and the redirect URI when that happens (or reserve a static domain).

Nothing in the app depends on ngrok. It is only a different `PUBLIC_URL`. In production, `PUBLIC_URL` is your real https domain.

To test Share & Earn on one machine, open the share link in a different browser/device (or an incognito window with a different User-Agent). Opening it on the same device as the sharer intentionally does not count.

---

## 7. Production deployment

### Checklist

```env
NODE_ENV=production
PUBLIC_URL=https://rewards.example.com     # must be https
TRUST_PROXY=1                              # when behind nginx/Caddy/a PaaS load balancer
MONGODB_URI=mongodb+srv://...              # Atlas or your managed MongoDB
SESSION_SECRET=...                         # npm run gen-secrets
DATA_ENCRYPTION_KEY=...                    # npm run gen-secrets  (store in a secrets manager; back it up)
GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...
ADMIN_REQUIRE_MFA=true
AI_API_KEY=...                             # optional
```

In production the server **refuses to start** if: `PUBLIC_URL` is not https, Google credentials are missing, dev login is enabled, or a secret is missing/too short. Session cookies are `Secure`, `HttpOnly`, `SameSite=Lax`; HSTS and a strict Content-Security-Policy are enabled.

### Option A – any Node host (Render, Railway, Fly.io, a VPS…)
1. Provision MongoDB (Atlas) and set the environment variables above in the host's dashboard. **Do not** commit `.env`.
2. Build command: `npm ci --omit=dev` · Start command: `npm start`. Health check path: `/api/health`.
3. Run `npm run create-admin` once from the host's shell (or from your laptop with `MONGODB_URI` pointing at production).
4. Run `npm run seed` only if you want the demo rewards.
5. Add the production redirect URI in Google Cloud.

### Option B – Docker
```bash
docker build -t g-coin-rewards .
docker run -d --name gcoin -p 3000:3000 --env-file .env.production g-coin-rewards
docker exec -it gcoin node scripts/create-admin.js --role superadmin --mfa
```
`docker compose --profile app up --build` runs the app with a local MongoDB container (fine for staging; use a managed database with backups for production).

### Option C – VPS with nginx
Run with `pm2` or systemd (`node src/server.js`), and terminate TLS in front:

```nginx
server {
  listen 443 ssl http2;
  server_name rewards.example.com;
  # ssl_certificate ... (e.g. from certbot)
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
Set `TRUST_PROXY=1` so rate limits and share fingerprints use the real client IP.

### Operations
- **Backups:** enable Atlas backups (or `mongodump`). Back up `DATA_ENCRYPTION_KEY` **separately**; without it stored voucher codes cannot be decrypted. Rotating the key requires re-encrypting existing codes (not automated).
- **Scaling:** the app is stateless (sessions live in MongoDB), so you can run several instances. See limitations for per-instance rate limits.
- **Recovery job:** on start and every 5 minutes the server repairs rare leftovers of a mid-request crash (stale `pending` redemptions are rolled back exactly once).
- **Logs:** JSON lines in production; request logs contain method, path, status and a request id, never bodies, cookies or codes.

---

## 8. Running the tests

The suite runs against a **real MongoDB** (it tests concurrency, unique indexes and atomic updates, which an in-memory fake cannot prove). Point it at a throwaway database; **the database name must contain `test`** because the suite drops it.

```bash
docker compose up -d mongo
export TEST_MONGODB_URI=mongodb://127.0.0.1:27017/gcoin_test
npm test
```

| File | Covers |
|---|---|
| `tests/auth.test.js` | First-login bonus is exactly 5 and idempotent (sequential retries and 20 concurrent sign-ins), sessions, CSRF, origin check, session-fixation protection, no leaked internals |
| `tests/shares.test.js` | Qualifying shares, duplicate/fake claims (same device, owner, bots, bad tokens, self-confirm, other users' shares), concurrent visits, daily cap, confirm mode with delay |
| `tests/redemption.test.js` | Exact balance updates, ledger + redemption records, idempotency keys, double-spend and oversell races, per-user limits, stale-redemption recovery, concurrent voucher assignment (no code assigned twice) |
| `tests/voucher-privacy.test.js` | Codes encrypted at rest; never in catalog/list/other users' responses; owner-only detail; `hidden` mode shows nothing; admin sees masked codes only; chatbot never reveals codes |
| `tests/admin-authz.test.js` | Anonymous/customer sessions cannot reach admin APIs, role matrix (viewer/admin/superadmin), password re-entry for sensitive actions, lockout, disabled/demoted admins lose access immediately, audit log, MFA (TOTP, replay protection, enforcement) |
| `tests/chatbot.test.js` | Grounding, sign-in requirement, no cross-user data, nothing sensitive sent to the provider, fallback on provider failure, input limits, disable switch |

---

## 9. How the rules work

**Signup bonus (exactly once).** After upserting the user by Google `sub`, the server runs one atomic update `{ _id, signupBonusGranted: { $ne: true } } → { $set: signupBonusGranted, $inc: coinBalance: 5 }`. Only one concurrent request can match; the rest see no change. The ledger row has a unique key `signup:<userId>` as a second guard.

**Redemption (no double spend, no oversell, no duplicate vouchers).** A small saga of single-document atomic steps:

1. Insert a `pending` redemption with a unique `(userId, Idempotency-Key)`. Replays return the original result and never charge again.
2. Reserve a per-user limit slot (atomic counter with `count < limit`).
3. Debit with `findOneAndUpdate({ coinBalance: { $gte: price } }, { $inc: { coinBalance: -price } })` so the balance can never go negative.
4. Reserve stock (`stock > 0`) **or** assign the oldest voucher with `findOneAndUpdate({ status: 'available' } → 'assigned')`, so a code can only go to one user.
5. Write the ledger entry (unique key per redemption), mark the voucher `redeemed`, mark the redemption `completed`.

If any step fails, exactly the steps already taken are undone (each undo is guarded by a persisted flag, so it happens once). The browser sends a fresh `Idempotency-Key` per confirmed click, so double-clicks and network retries are safe.

**Voucher modes** (set per reward by admins):
- `reveal`: a code is assigned and shown **only** to the redeeming user (via the owner-scoped redemption detail endpoint).
- `hidden`: a code is assigned and tracked for inventory but never shown in the app (fulfilment by email/desk, per the reward's redemption details).
- `none`: no codes; availability is governed by `stock` (blank = unlimited).

Voucher codes are encrypted with AES-256-GCM, with a keyed hash used only to reject duplicates. Customer APIs never include inventory counts, only a derived availability label (Available / Low stock / Out of stock).

**Share & Earn (server-defined "qualifying share").**
- A share link is a server-issued, unguessable token bound to one user and one reward; one bonus-eligible share per user per reward.
- Default (`SHARE_REQUIRE_VISIT=true`): the bonus is paid when the link is opened by a **different device** than the creator's, by a non-bot, not signed in as the sharer. Unique visitor fingerprints are keyed hashes of IP + User-Agent (no raw IPs stored).
- Alternative (`SHARE_REQUIRE_VISIT=false`): the user confirms after `SHARE_MIN_DELAY_SECONDS`.
- At most `SHARE_DAILY_BONUS_LIMIT` bonuses per user per day, enforced inside the same atomic update that adds the coins. Extra qualified shares wait and can be claimed on a later day. Each bonus appears in transaction history.

---

## 10. Security design

| Concern | Measure |
|---|---|
| Authentication | Google OAuth with `state` + PKCE, ID-token verification, verified email required; admins: bcrypt(12) + optional TOTP MFA, lockout, rate limiting |
| Sessions | Server-side sessions in MongoDB; opaque HttpOnly SameSite=Lax cookies (Secure in production); ID rotated on login; separate customer/admin cookies, stores and lifetimes |
| Authorization | Middleware on every route; admin role and `disabled` state re-read from the database per request; customer data always scoped by the session's user id (other users' ids behave as "not found") |
| CSRF | Per-session synchronizer token (`X-CSRF-Token`) on all state-changing requests plus an `Origin` allow-list check; SameSite cookies as defense in depth |
| Injection / XSS | zod validation with unknown fields rejected; Mongo query strings parsed in simple mode and IDs validated; the front end escapes all dynamic output by default; strict CSP (no inline scripts or styles) |
| Headers | Helmet: CSP, HSTS (prod), `frame-ancestors 'none'`, referrer policy, `X-Content-Type-Options`; `Cache-Control: no-store` on API responses |
| Rate limiting | Global API, sign-in, admin login, redeem, share and chat limiters; chat daily cap |
| Secrets | Only via environment variables; startup validation; none returned by any API or written to logs |
| Data protection | Voucher codes and MFA secrets encrypted at rest (AES-256-GCM, HKDF-derived per-purpose keys); admin audit log stores no secrets |
| Errors | Unexpected errors return a generic message plus a request id; details are logged server-side only |
| Integrity | Unique indexes on ledger idempotency keys, redemption keys, `(userId, rewardId)` shares, `(rewardId, codeHash)` vouchers |

---

## 11. Project layout and API overview

```
src/
  server.js            entry: connect, serve, reconcile timer, graceful shutdown
  app.js               middleware order, route mounting
  config.js            env parsing + production safety checks
  db.js                pooled Mongo connection, index build
  models/              User, Reward, VoucherCode, Redemption, CoinTransaction, Share, RewardUserCount, Admin, AuditLog
  middleware/          security (headers, CSRF, origin), session, auth (requireUser / requireAdmin(role)), rateLimit, validate, error
  services/            userAuth, ledger, rewards, vouchers, redemptions, shares, reconcile, adminAuth, audit, chatbot, ai
  routes/              public (health, config, share landing), auth, user, admin
  lib/                 crypto, totp, util, errors, logger
public/                customer SPA (index.html, js/app.js), admin SPA (admin/), css, images
scripts/               seed, create-admin, gen-secrets
tests/                 Jest + Supertest suites
```

Customer API (`/api`, requires sign-in unless noted): `GET /config`, `GET /session` (public), `GET /auth/google` (public), `POST /auth/logout`, `GET /me`, `GET /me/transactions`, `GET /rewards`, `GET /rewards/:id`, `POST /rewards/:id/redeem` (header `Idempotency-Key`), `GET /redemptions`, `GET /redemptions/:id` (owner only, includes the code when revealed), `GET|POST /shares`, `POST /shares/:id/confirm|claim`, `POST /chat`. Public: `GET /r/:token` (share landing page), `GET /api/health`.

Admin API (`/api/admin`, separate session): `login`, `logout`, `session`, `mfa/setup|enable|disable`, `stats`, `rewards` (CRUD; delete = superadmin + re-auth), `rewards/:id/vouchers` (list masked / add), `vouchers/:id` (delete unassigned; superadmin + re-auth), `users`, `transactions`, `redemptions`, `inventory`, `audit`. All list endpoints are paginated (`?page=&limit=`).

---

## 12. Known limitations

- **Rate limiters and the chat daily cap are in-process memory.** With several instances each has its own counters (limits are effectively multiplied). For strict global limits, swap in a Redis store for `express-rate-limit`.
- **Share qualification is heuristic.** IP + User-Agent fingerprints, bot filtering and per-reward/day caps raise the cost of abuse considerably but cannot prove a human saw a link; a determined attacker with many devices could still farm the capped bonus. Tune `SHARE_DAILY_BONUS_LIMIT` to your risk tolerance.
- **Reward images are URLs** (https links or `/img/...` paths); there is no upload pipeline. Host images on your CDN or add files to `public/img/`.
- **`hidden` voucher fulfilment is manual** (the admin sees the redemption, the user sees the reward's redemption details).
- **Key rotation** for `DATA_ENCRYPTION_KEY` is not automated.
- The Google OAuth and live AI-provider calls need your real credentials, so they were verified with mocks and by code review against the providers' documented APIs, not against live accounts. Do a manual end-to-end sign-in and one chat message after configuring them.
- The `Dockerfile` and `docker-compose.yml` follow standard patterns but could not be built in the environment this project was authored in (no Docker daemon). Run `docker build .` once before relying on them.
