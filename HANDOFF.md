# Upgrade included: Scout v2 + Birdman Analyst v1

See SCOUT-PUBLISHING.md for the new architecture, Pro endpoints, migration, validation and remaining research-publisher connection. The original handoff below describes the base snapshot only. This upgraded package has not been deployed.

# Birdman Picks — project handoff

Snapshot of `main` at commit `3f74599` (Nov 7, 2026). Repository: https://github.com/robdv081/birdman-picks (public).
This ZIP is the repository's tracked files plus this guide and `.env.example`. Nothing here has been deployed or committed.
No secrets are in the repo or this ZIP: no API keys, tokens, passwords, `.env` files, customer data or payment details.

---

## 1. Where it runs

| Piece | Where | How it gets there |
|---|---|---|
| **Frontend** (React 18 + TypeScript + Vite, a PWA) | GitHub Pages: https://robdv081.github.io/birdman-picks/ | `.github/workflows/deploy.yml` on every push to `main` and every 30 min (refreshes DFS salary files) |
| **Backend** (Cloudflare Worker `birdman-picks`, TypeScript) | https://birdman-picks.birdmanpicks.workers.dev | Deployed by hand with `npx wrangler deploy` from `server/`. `.github/workflows/server.yml` can deploy automatically but skips: the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets aren't set |
| **Database** | Cloudflare D1, database `birdman` (binding `DB`) | `server/schema.sql` |
| **Pick agent** | GitHub Actions (`.github/workflows/agent.yml`) | ~12:15, 5:15, 7:15 PM ET; manual run with a dry-run switch |
| **Payments** | Stripe Payment Link (live mode) + Stripe Billing customer portal | Checkout return handled by the Worker |

Data sources (all public, no keys): ESPN site/core APIs (scoreboards, odds incl. DraftKings and other books, player props, game logs, rosters, injuries, box scores), Open-Meteo (weather), DraftKings/FanDuel public salary lists (`scripts/fetch-salaries.mjs`). Visit counts: GoatCounter (no cookies).

## 2. AI providers and model routing

**There are none.** No LLM or AI API is called anywhere in the app, server or agent.
"Model" in the app means statistics, all in `src/`:
- `src/propgen.ts` — player props: last-10-game hit rate on DraftKings "N+" milestone lines, shrunk toward the book's implied probability (`PRIOR`), edge = estimate − break-even. Also builds prop parlays.
- `src/gamelines.ts` — college football/basketball sides: ESPN FPI/BPI win probability and projected margin blended with the price.
- `src/bets.ts` — odds math, closing line value (`clv`), grading (`gradeSelection`), capped fractional Kelly staking (`kellyUnits`).
- `src/grader.ts` — settles bets and records DraftKings closing lines from ESPN.

So Scout/Analyst would be the first AI integration. Nothing has to be re-routed.

## 3. Pro section, paid access and subscriptions

- **UI:** `src/components/Pro.tsx` — `ProGate` (wraps Pro features, shows the upgrade card), `ProCard` (status, renewal, Manage billing, restore), `ProNotice` (post-checkout message).
- **Client logic:** `src/pro.ts` — payment link, checkout claim, status refresh on launch/focus, 24 h offline grace.
- **Pro features gated today:** prop parlay builder (`PropBuilder.tsx`), lineup generator (`Generator.tsx`), Best edges (`Today.tsx`), report card (`ReportCard.tsx`).
- **Server:** `server/pro.ts`
  1. Buyer pays via the Stripe Payment Link; Stripe redirects to `/?session_id={CHECKOUT_SESSION_ID}`.
  2. `POST /api/pro/claim` retrieves the Checkout Session, confirms it's paid and the customer has an `active`/`trialing` subscription, and returns an HMAC-signed token (`TOKEN_SECRET`) holding the Stripe customer id.
  3. `GET /api/pro/status` (Bearer token) re-checks the subscription with Stripe on every app launch.
  4. `POST /api/pro/portal` opens the Stripe customer portal. `/api/pro/restore/start|verify` emails a 6-digit code (Resend; not configured yet).
- **Authentication:** there are no user accounts or passwords. Identity = the Pro token (per device), the owner key (`ADMIN_KEY`), the agent key (`AGENT_KEY`), and per-member pick'em tokens (stored hashed).
- **Important for Scout/Analyst:** the current Pro features run entirely in the browser, so the gate is UI-only and a technical user could bypass it. Anything paid that Scout/Analyst produce should be generated and stored server-side and served only from endpoints that check the Pro token (like `/api/pro/status` does).

## 4. Database

`server/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`). There is no migration framework; one manual migration has been applied to production:

```sql
-- 2026-11-07: who posted each record pick
ALTER TABLE picks ADD COLUMN author TEXT NOT NULL DEFAULT 'owner';
```

| Table | Holds |
|---|---|
| `picks` | The public verified record: append-only, server-timestamped, refused after kickoff, hash-chained (`prev_hash`, `hash`), graded with close odds/line. `author` = `owner` or `model`. |
| `pools`, `members`, `entries` | Free pick'em (no money, no prizes). |
| `restore_codes` | Pro restore-by-email codes (hashed). |

Production row counts at handoff: picks 0, pools 0, members 0, entries 0. The pick agent's first live run is scheduled for 5:15 PM ET on Nov 7.

**Hash chain warning:** `src/recordhash.ts` defines exactly which fields each pick's fingerprint covers; the app re-verifies the whole chain on every phone. Once picks exist, changing `lockedFields` breaks verification of old picks. Add a version field instead of editing it.

**There are no tables for reports, fantasy lineups or a paper ledger.** Those live only in each user's browser (`localStorage`):

| Key | Contents |
|---|---|
| `bp.bets` | Bet tracker / paper ledger: every bet with stake in units, status (including losses), close odds, legs |
| `bp.lineups` | Saved dated fantasy lineups |
| `bp.settings` | Unit size, bankroll, weekly limit |
| `bp.slip`, `bp.starred`, `bp.pools`, `bp.ownerKey`, `bp.pro.*` | Parlay slip, Red Zone stars, pick'em memberships, owner sign-in, Pro token |

They are not in the repo, this ZIP or the server, and nothing here modifies them. To preserve them, use **My Bets → Export backup** on each device (JSON with every bet, including losses, and every dated lineup); **Import** restores it. If Scout/Analyst need a server-side ledger, add new tables and import from that export. Don't rewrite or merge existing entries.

## 5. Scheduled jobs and publishing endpoints

| Job | Schedule | Does |
|---|---|---|
| Worker cron (`server/index.ts` → `settleAll`) | every 5 min | Records closing lines, grades record picks and pick'em entries |
| `deploy.yml` | push + every 30 min | Fetch salaries, build, publish frontend |
| `agent.yml` | 17:15, 22:15, 00:15 UTC | `scripts/agent.ts`: up to 3 model picks/day, one per game, odds −200..+180, edge 5–15 pts (props) / 4–15 (lines), skips questionable players |
| `server.yml` | push to server files | Tests + deploys the Worker (currently skips: no Cloudflare secrets) |

Endpoints (`server/index.ts`):

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | — |
| GET | `/api/record` | public |
| POST | `/api/record/picks` | Bearer `ADMIN_KEY` (owner) or `AGENT_KEY` (model) |
| GET | `/api/record/owner` | Bearer `ADMIN_KEY` |
| POST | `/api/pools`, `/api/pools/join` | — |
| GET / PUT | `/api/pools/:code`, `/api/pools/:code/picks` | `X-Pool-Token` |
| POST | `/api/pro/claim` | Stripe session id |
| GET | `/api/pro/status` | Bearer Pro token |
| POST | `/api/pro/portal` | Bearer Pro token |
| POST | `/api/pro/restore/start`, `/api/pro/restore/verify` | email + code |

The server only allows browser requests from `ALLOWED_ORIGIN`. Picks are refused once ESPN shows the game started or its start time has passed.

`SCOUT-PUBLISHING.md`: **not present.** There is no Scout or Analyst code yet.

## 6. Configuration

See `.env.example` for every name. Where each value actually lives:
- Frontend: `VITE_SERVER_URL` comes from the GitHub Actions **variable** `SERVER_URL` at build time.
- Worker plain vars: `ALLOWED_ORIGIN`, `APP_URL` in `server/wrangler.toml`.
- Worker secrets (set with `npx wrangler secret put NAME`): `STRIPE_SECRET_KEY` (a restricted key), `TOKEN_SECRET`, `ADMIN_KEY`, `AGENT_KEY`; optional `RESEND_API_KEY`, `FROM_EMAIL`.
- GitHub repo secret: `AGENT_KEY` (same value as the Worker's).
- The payment link URL is hard-coded in `src/pro.ts` (it's public by design).

## 7. Run and test locally

Needs Node 20+ (22 recommended).

```bash
# Frontend
npm ci
echo "VITE_SERVER_URL=http://localhost:8787" > .env.local   # or leave unset: Record, Pick'em and Pro switch off
npm run dev            # http://localhost:5173
npm run build          # type-check + production build

# Backend
cd server
npm install
npm test               # 19 tests: record rules, hash chain, grading/CLV, pools, CORS, Pro with Stripe faked
npx wrangler d1 execute birdman --local --file=schema.sql
npx wrangler dev       # http://localhost:8787 with a local D1
# For local secrets, put NAME=value lines in server/.dev.vars (never commit it)
# Set ALLOWED_ORIGIN=http://localhost:5173 there too, so the dev frontend is allowed

# Pick agent (reads the record, scans today's games, posts nothing)
cd ..
SERVER_URL=http://localhost:8787 node scripts/run-agent.mjs --dry
```

Stripe in local testing: use test-mode keys and a test Payment Link (`buy.stripe.com/test_...`). The live link in `src/pro.ts` charges real cards.

## 8. Things to keep

- Record picks are append-only. There's no edit or delete endpoint, by design.
- Ledger entries and dated lineups are user-owned browser data; migrate by import, never overwrite.
- Pick'em has no entry fees or prizes. Adding either can make it a regulated contest.
- Responsible-gambling items: 21+ notice and 1-800-GAMBLER in the footer, weekly stake limit with warnings.
