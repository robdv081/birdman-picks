// Where visitors come from, for the owner. Private by design: no cookies, no IP addresses, nothing per person.
// The app sends one note per visit (per browser session): where it came from (link tag, referring site or
// "direct"), which page it landed on, the device type and whether this browser has visited before. The server
// only keeps daily counts. A few actions are counted the same way, so the owner can see what visits lead to.
import { isAdmin } from './record';
import { HttpError, easternDate, json, readJson, type Deps, type Env } from './util';

const tag = (v: unknown, fallback: string) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : '';
  return /^[a-z0-9._-]+$/.test(s) ? s : fallback;
};

export const EVENTS = ['player_created', 'player_pick', 'pro_claim', 'alerts_on'] as const;
export type EventKind = (typeof EVENTS)[number];

/** POST /api/hit — one visit. Bots and junk are dropped quietly. */
export async function hit(request: Request, env: Env, deps: Deps) {
  const ua = request.headers.get('User-Agent') || '';
  if (/bot|crawl|spider|preview|headless|lighthouse/i.test(ua)) return json({ ok: true });
  const b = await readJson(request, 2000);
  const row = {
    day: easternDate(deps.now()),
    source: tag(b.source, 'direct'),
    medium: tag(b.medium, 'none'),
    campaign: tag(b.campaign, '-'),
    landing: tag(b.landing, 'today'),
    device: ['mobile', 'desktop', 'tablet', 'app'].includes(String(b.device)) ? String(b.device) : 'other',
    repeat: b.returning === true ? 1 : 0,
  };
  await env.DB.prepare(
    `INSERT INTO visits (day, source, medium, campaign, landing, device, repeat_visit, n) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (day, source, medium, campaign, landing, device, repeat_visit) DO UPDATE SET n = n + 1`
  )
    .bind(row.day, row.source, row.medium, row.campaign, row.landing, row.device, row.repeat)
    .run();
  return json({ ok: true });
}

/** Count something a visitor did (never who did it). Never gets in the way of the action itself. */
export async function bump(env: Env, now: number, kind: EventKind) {
  await env.DB.prepare('INSERT INTO events (day, kind, n) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1')
    .bind(easternDate(now), kind)
    .run()
    .catch(() => {});
}

/** GET /api/stats?days=30 — owner only. */
export async function stats(request: Request, env: Env, deps: Deps) {
  if (!isAdmin(request, env)) throw new HttpError(401, 'Owner key required.');
  const days = Math.max(1, Math.min(90, Number(new URL(request.url).searchParams.get('days')) || 30));
  const from = easternDate(deps.now() - (days - 1) * 86400_000);
  const q = (sql: string) => env.DB.prepare(sql).bind(from).all<Record<string, string | number>>().then((r) => r.results);
  const [daily, sources, campaigns, landing, devices, events] = await Promise.all([
    q('SELECT day, SUM(n) AS visits, SUM(CASE WHEN repeat_visit = 0 THEN n ELSE 0 END) AS new FROM visits WHERE day >= ? GROUP BY day ORDER BY day'),
    q('SELECT source, medium, SUM(n) AS visits, SUM(CASE WHEN repeat_visit = 0 THEN n ELSE 0 END) AS new FROM visits WHERE day >= ? GROUP BY source, medium ORDER BY visits DESC LIMIT 25'),
    q("SELECT campaign, source, SUM(n) AS visits FROM visits WHERE day >= ? AND campaign != '-' GROUP BY campaign, source ORDER BY visits DESC LIMIT 25"),
    q('SELECT landing, SUM(n) AS visits FROM visits WHERE day >= ? GROUP BY landing ORDER BY visits DESC LIMIT 15'),
    q('SELECT device, SUM(n) AS visits FROM visits WHERE day >= ? GROUP BY device ORDER BY visits DESC'),
    q('SELECT kind, SUM(n) AS n FROM events WHERE day >= ? GROUP BY kind'),
  ]);
  return json({ days, from, daily, sources, campaigns, landing, devices, events: Object.fromEntries(events.map((e) => [e.kind, e.n])) });
}
