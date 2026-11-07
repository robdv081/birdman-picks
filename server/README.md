# Birdman Picks server

A Cloudflare Worker (free plan) with a D1 database. It runs:

- **Birdman's record** (`/api/record`): picks you post are stamped with the server's clock, refused once the game starts, chained by hash so any edit or deletion shows, and graded automatically from ESPN with DraftKings' closing line for CLV. The app re-checks the chain on every phone.
- **Pick'em pools** (`/api/pools`): free, no prizes. Friends join with a 6-letter code, pick winners, and climb weekly and all-time leaderboards. Picks lock at kickoff and stay hidden until then.
- **Pro** (`/api/pro/*`): Stripe Payment Link checkout, subscription checks, billing portal, restore by emailed code.
- A job every 5 minutes grades picks and pools and records closing lines.

It reuses the app's own grading code (`src/grader.ts`, `src/bets.ts`, `src/espn.ts`), so the record grades exactly the way My Bets does.

## One-time setup (about 15 minutes)

1. **Cloudflare account** at cloudflare.com (free).
2. **Database.** In the Cloudflare dashboard: Storage & Databases → D1 → Create → name it `birdman`. Copy its **Database ID** into `wrangler.toml` where it says `PASTE_DATABASE_ID_HERE`.
3. **API token.** My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, and add the permission **Account → D1 → Edit**. Copy the token, and copy your **Account ID** from the dashboard home page.
4. **GitHub secrets.** In the birdman-picks repo: Settings → Secrets and variables → Actions → New repository secret: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. **Deploy.** Push, or run the "Deploy server" action from the Actions tab. It creates the tables and publishes the server. Its address looks like `https://birdman-picks.<you>.workers.dev`.
6. **Server settings.** Cloudflare → Workers → birdman-picks → Settings → Variables and Secrets, add:
   - `ADMIN_KEY` (secret): a long random password, at least 16 characters. It's what you type at **Record → Owner sign-in** to post picks. Keep it private.
   - For Pro: `STRIPE_SECRET_KEY` and `TOKEN_SECRET`; optionally `RESEND_API_KEY` and `FROM_EMAIL` for restore emails.
7. **Point the app at it.** GitHub repo → Settings → Secrets and variables → Actions → **Variables** tab → `SERVER_URL` = the server address from step 5. The next app deploy turns on the Record and Pick'em tabs.

## Posting a pick
Sign in once on the Record tab with your `ADMIN_KEY`. Then tap any price on Scores (or track a prop from a game's details), write why you like it in Notes, and tap **Post to my record**. Straight bets only: moneylines, spreads, totals and player props.

## Tests
`npm test` builds the worker and runs it against SQLite: posting and lock rules, the hash chain, grading and CLV, pools and leaderboards, CORS, and Pro with Stripe faked.
