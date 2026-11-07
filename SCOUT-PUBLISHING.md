# Scout v2 and Birdman Analyst v1

> **Changes made when this was merged (Nov 7, 2026):**
> - The **Scout tab is hidden** until the Worker secret `SCOUT_PUBLISH_KEY` is set. The app asks `GET /api/scout/enabled` (public, `{enabled}`); setting the key is what "connecting a publisher" means. `#scout` still works directly and stays behind the Pro check. Scout is not listed among the Pro perks until then.
> - **The cron no longer writes schedule-only reports.** Those were empty rows every 30 minutes, and the 5-minute cron's small free-plan CPU budget is kept for grading the public record. `refreshResearch` still exists but nothing calls it.
> - **Research only downloads the schedules it needs** (the leagues of the submitted markets). An empty report fetches nothing, so `feeds` lists only the researched leagues.
> - **The Scout page re-checks every 5 minutes** (not every minute), skips checks while hidden, and keeps the current report on screen while refreshing.
> - The tab sits after Pick'em instead of first.

Prepared implementation; not deployed. This extends Claude's November 7 handoff.

## What runs

- Scout v2: a backend evidence-validation agent. Rechecks today's NFL, CFB, NBA, NHL and MLB schedules, marks source failures stale, requires matching future starts, fresh official/bookmaker evidence and confirmed availability.
- Birdman Analyst v1: a deterministic selection agent. Calculates break-even from American odds and selects at most three distinct events, flat hypothetical one unit each. Requires publisher-supplied independent model estimates with method and validation documentation; accepts a conservative 3–15 percentage point gap. This is a review threshold, not a profitability guarantee or model calibration result.
- Neither is an LLM. No paid AI provider was selected or added. Existing statistical agent and its public record are unchanged.
- (Superseded, see the top of this file.) The five-minute Worker cron was going to create a schedule-only no-picks report when the latest research is 30 minutes old. It does NOT fetch injury reports, sportsbook pages or build independent probabilities. Full automated research requires a trusted publisher feeding the contract below. No integration with the old chatgpt.site publisher is present or implied.

## Install (owner/developer, after review)

1. Review changes against original handoff. Run `npm ci && npm run build` at root; `npm ci && npm test` in server.
2. Apply **only** `server/migrations/002-scout.sql` to the existing D1 database, using your normal Cloudflare tooling. It is additive/idempotent. Fresh installs can use schema.sql.
3. Set a new Worker secret `SCOUT_PUBLISH_KEY` with `wrangler secret put SCOUT_PUBLISH_KEY`. Use a unique random value; never expose it in frontend, reports, repository or chat. This is separate from ADMIN_KEY, AGENT_KEY, Pro tokens and Sites service tokens.
4. Deploy the Worker and frontend via your existing reviewed deployment process. No deployment was performed here.
5. Connect your trusted research publisher to POST `/api/scout/research`. No publisher means automatic schedule-only reports and no verified picks; that is expected.
6. Pro members open `#scout`. Backend GET `/api/pro/scout` checks signed Pro token and current Stripe subscription every time, even when browser offline grace says Pro is active. Endpoint sends no-store responses.

## Publisher contract

POST `/api/scout/research`, Authorization: Bearer <SCOUT_PUBLISH_KEY>.
Body: `{ "markets": [] }` for no picks or up to ten ResearchMarket objects. Maximum request size remains 8 KiB. Every field is defined in `src/scout.ts`.

Each market needs league, ESPN eventId, ISO start including timezone, exact market, integer American odds, bookmaker, availabilityConfirmed=true, counterarguments, passIf, and evidence entries `{url, checkedAt, kind, note}`. Evidence must include an official league source and a bookmaker source checked in the last 30 minutes. No future timestamps. Official source host allowlist: nfl.com, ncaa.com, nba.com, nhl.com, mlb.com and their subdomains. Team/conference domains currently require a reviewed allowlist extension. A claim of kind=official on another hostname is refused.

Optional estimate: `{probability, method, validation, source}`. It must describe a genuinely independent estimated probability, methodology and held-out validation. Missing/invalid estimate = pass. The code verifies structure and provenance constraints; it cannot prove that an authenticated publisher's assertions or calibration claims are true. Configure the publisher with reliable source retrieval and human/model validation. URL strings are not fetched as arbitrary server destinations.

Scout rechecks schedule on ingestion and on member reads. Started games, conflicting start times, or events within ten minutes of start pass. Reads hide stale candidates and revalidate live game status without altering stored report history. A returned empty slate only means the feed returned no events, not independently confirmed offseason status.

Response 201: `{published:true,report}` including server checkedAt, Eastern date, five feed checkedAt/stale fields, candidates, and pass reasons. Read back GET `/api/pro/scout` using an active member credential to verify publication. Never use Pro credentials to publish.

## History and grading

`scout_reports` stores an append-only history of research reports, including passes and no-pick runs. It does not write `picks`, edit hash-chain fields, grade selections, import Birdman history, or touch browser keys bp.bets/bp.lineups. Report candidates are paper research, not accepted ledger entries. Do not grade them as accepted picks. Existing public-record cron grading remains unchanged.

Fantasy salaries, eligibility and caps are not supplied by this contract; no new fantasy lineup is generated. Existing cards remain dated. Personal browser backups are still the owner's responsibility, as in HANDOFF.md.

## Validation performed

Frontend TypeScript production build; separate backend strict TypeScript check; 27 server tests including original 19 plus stale/future/forged sources, schedule conflict/live state, duplicates, no estimate, feed failure, authenticated publisher, append-only storage, active/lapsed membership, stale report filtering and cron freshness. Browser visual smoke test was attempted but Chromium launch is blocked in this environment (`socket() failed: Operation not permitted`). Live Stripe, D1 migration/deployment and real publisher integration have not been tested.
