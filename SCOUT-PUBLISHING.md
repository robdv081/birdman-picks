# Scout + Birdman Analyst, and Pro alerts

Both are Pro features. Nothing here places bets, writes to the public record, or touches anyone's bets or lineups.

## Scout + Analyst

**What runs:** `.github/workflows/scout.yml` runs `scripts/scout.ts` every 30 minutes, 10 AM to midnight Eastern
(`node scripts/run-scout.mjs --dry` shows a report without publishing).

- **Scout** reads today's NFL, NBA, NHL, college football and men's college basketball schedules from ESPN, ESPN's
  injury reports (NFL, NBA, NHL; ESPN doesn't publish college ones) and DraftKings' prices from ESPN's odds feed,
  including how each line moved since it opened.
- **Birdman Analyst** runs the pick agent's model (player game logs for props, ESPN FPI/BPI for college lines),
  then keeps at most 3 paper picks, one per game: a 4–15 point model edge, a price from -200 to +180, at least
  30 minutes before the start, and no questionable players. Each pick lists its sources (ESPN pages and DraftKings,
  with the time checked), the break-even win rate, why it could lose, and when to pass. If nothing qualifies, or the
  evidence is missing, the page says **No verified picks** and lists what was passed and why.

**What the server checks** (`server/scout.ts`, `POST /api/scout/research`, `Authorization: Bearer SCOUT_PUBLISH_KEY`):
the research is under 20 minutes old; each pick cites only ESPN or DraftKings pages checked within 30 minutes and
includes the schedule, the price and an injury or stats check; it starts more than 10 minutes out; the server
recomputes the break-even and edge itself and passes anything outside 3–15 points; at most 3 picks, one per game.
Reports are stored append-only in `scout_reports`. Pro members read the latest with `GET /api/pro/scout`, which
checks their subscription each time, hides picks within 10 minutes of the start, and hides all picks once the
report is over 75 minutes old.

The Scout tab appears for everyone once `SCOUT_PUBLISH_KEY` is set on the Worker (`GET /api/scout/enabled`);
non-members see what it is and how to unlock it.

## Pro alerts (Web Push)

Pro members turn alerts on from the Scout or Record tab. They get:

- **New picks:** a push when any pick lands on the public record (checked every 5 minutes by the Worker cron).
- **Line moves:** on pending picks they follow (🔔 Follow line on the Record tab). Each Scout run sends current
  DraftKings prices for pending record picks to `POST /api/push/moves`; a follower hears about a half-point line
  move or a 2-point move in the price's implied odds, and whether it moved toward or away from the pick.

Pushes carry no data. The phone's service worker collects the message from `POST /api/push/pull`, proving which
phone it is with its subscription's own secret. The server signs each push with a VAPID key (`VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_JWK` Worker secrets). Subscriptions are re-confirmed, and Pro re-checked, each time the app opens;
ones not seen for 35 days are dropped, as are ones the push service reports gone. iPhone needs the app added to the
Home Screen first (Apple's rule for web apps).

## Setup (done Nov 7, 2026)

1. D1 migrations `002-scout.sql` and `003-push.sql`.
2. Worker secrets `SCOUT_PUBLISH_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK`; GitHub secret `SCOUT_PUBLISH_KEY`
   (same value as the Worker's).
3. Deploy the Worker; the site redeploys from GitHub.
