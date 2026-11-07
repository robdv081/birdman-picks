// Pro phone alerts through Web Push. Two kinds:
//   • a new Birdman pick lands on the public record
//   • the line moves on a pick a member follows (prices come from the Scout publisher every 30 minutes)
// Pushes carry no data. The phone wakes up, and its service worker asks /api/push/pull for the message, proving
// who it is with the subscription's own auth secret. So nothing readable crosses the push service, and the server
// needs no payload encryption: only a signed VAPID token (ES256) per push service.
import { breakEven } from '../src/scout';
import { requirePro } from './pro';
import { b64url, bearer, HttpError, json, readJson, sha256, str, timingSafeEqual, type Deps, type Env } from './util';

const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
/** Subscriptions are re-confirmed (and Pro re-checked) each time the app opens; ones not seen in this long lapse. */
const SUB_TTL_MS = 35 * 24 * 3600_000;
const OUTBOX_TTL_MS = 2 * 24 * 3600_000;
const SENDS_PER_RUN = 30; // the free Worker plan allows 50 outside requests per run, and grading needs some
/** Line-move alerts need the line to move half a point, or the price to move 2 points of win probability. */
const LINE_STEP = 0.5;
const PRICE_STEP = 0.02;

type Obj = Record<string, unknown>;

function pushEndpoint(v: unknown) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'https:' || u.username || u.password || String(v).length > 800) return null;
    return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h)) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The subscription named in the body, if its auth secret matches. */
async function subFrom(env: Env, b: Obj) {
  const endpoint = pushEndpoint(b.endpoint);
  const auth = str(b.auth, 64);
  if (!endpoint || auth.length < 16) throw new HttpError(400, 'Alert subscription missing.');
  const sub = await env.DB.prepare('SELECT id, auth_hash FROM push_subs WHERE id = ?').bind(await sha256(endpoint)).first<{ id: string; auth_hash: string }>();
  if (!sub || !timingSafeEqual(sub.auth_hash, await sha256(auth))) throw new HttpError(404, 'Alerts are off on this device. Turn them on again.');
  return sub.id;
}

export const pushKey = (env: Env) => json({ key: env.VAPID_PUBLIC_KEY || null }, 200, { 'Cache-Control': 'public, max-age=3600' });

/** Pro members turn alerts on (and the app re-confirms each launch, which also re-checks Pro). */
export async function subscribe(request: Request, env: Env, deps: Deps) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) throw new HttpError(503, "Alerts aren't set up on the server yet.");
  const { customer, renews } = await requirePro(request, env);
  // Alerts stop when the paid period ends, unless the app re-confirms a renewed membership before then.
  const renewsAt = renews ? Date.parse(renews) : NaN;
  const proUntil = Number.isFinite(renewsAt) ? renewsAt + 2 * 24 * 3600_000 : deps.now() + SUB_TTL_MS;
  const b = await readJson(request);
  const endpoint = pushEndpoint(b.endpoint);
  const auth = str(b.auth, 64);
  if (!endpoint) throw new HttpError(400, "This browser's push service isn't supported.");
  if (auth.length < 16) throw new HttpError(400, 'Alert subscription missing.');
  const id = await sha256(endpoint);
  const now = deps.now();
  const picks = b.picks === false ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO push_subs (id, endpoint, auth_hash, customer, picks, created_at, seen_at, fails, pro_until) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET auth_hash = excluded.auth_hash, customer = excluded.customer, picks = excluded.picks, seen_at = excluded.seen_at, fails = 0, pro_until = excluded.pro_until`
  )
    .bind(id, endpoint, await sha256(auth), customer, picks, now, now, proUntil)
    .run();
  const follows = await env.DB.prepare('SELECT pick_id FROM push_follows WHERE sub_id = ?').bind(id).all<{ pick_id: string }>();
  return json({ ok: true, picks: !!picks, following: follows.results.map((r) => r.pick_id) });
}

export async function unsubscribe(request: Request, env: Env) {
  const id = await subFrom(env, await readJson(request));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_follows WHERE sub_id = ?').bind(id),
    env.DB.prepare('DELETE FROM push_outbox WHERE sub_id = ?').bind(id),
    env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

/** Follow (or stop following) line moves on a pending pick from the public record. */
export async function follow(request: Request, env: Env, deps: Deps) {
  const b = await readJson(request);
  const id = await subFrom(env, b);
  const pickId = str(b.pickId, 40);
  if (b.on === false) {
    await env.DB.prepare('DELETE FROM push_follows WHERE sub_id = ? AND pick_id = ?').bind(id, pickId).run();
    return json({ following: false });
  }
  const pick = await env.DB.prepare("SELECT id, odds, line, start_at FROM picks WHERE id = ? AND status = 'pending'").bind(pickId).first<{ odds: number; line: number | null; start_at: number }>();
  if (!pick || pick.start_at <= deps.now()) throw new HttpError(409, 'That game has started, so there are no more line moves to follow.');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_follows WHERE sub_id = ?').bind(id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 25) throw new HttpError(429, 'You can follow up to 25 picks at a time.');
  await env.DB.prepare('INSERT OR IGNORE INTO push_follows (sub_id, pick_id, odds, line, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, pickId, pick.odds, pick.line, deps.now())
    .run();
  return json({ following: true });
}

/** The phone's service worker collects its messages after a push wakes it. */
export async function pull(request: Request, env: Env, deps: Deps) {
  const id = await subFrom(env, await readJson(request));
  const rows = await env.DB.prepare(
    'SELECT id, title, body, url, tag FROM push_outbox WHERE sub_id = ? AND delivered = 0 AND created_at > ? ORDER BY id DESC LIMIT 4'
  )
    .bind(id, deps.now() - 24 * 3600_000)
    .all<{ id: number; title: string; body: string; url: string; tag: string }>();
  if (rows.results.length) await env.DB.prepare('UPDATE push_outbox SET delivered = 1, sent = 1 WHERE sub_id = ? AND delivered = 0').bind(id).run();
  return json({ messages: rows.results.map(({ title, body, url, tag }) => ({ title, body, url, tag })) });
}

const fmtOdds = (o: number) => (o > 0 ? `+${o}` : `${o}`);
const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/**
 * Current prices for pending picks, from the Scout publisher. Members following a pick hear about a real move:
 * whether it went their way (they hold a better number than the market now offers) or against them.
 */
export async function moves(request: Request, env: Env, deps: Deps) {
  const key = bearer(request);
  if (!env.SCOUT_PUBLISH_KEY || !key || !timingSafeEqual(key, env.SCOUT_PUBLISH_KEY)) throw new HttpError(401, 'Scout publisher key required.');
  const b = await readJson(request, 32_000);
  const list = Array.isArray(b.moves) ? b.moves.slice(0, 30) : [];
  const now = deps.now();
  const appUrl = (env.APP_URL || '').replace(/#.*$/, '');
  let queued = 0;
  for (const m of list as Obj[]) {
    const pickId = str(m.pickId, 40);
    const odds = Number(m.odds);
    const line = m.line == null ? null : Number(m.line);
    if (!pickId || !Number.isInteger(odds) || Math.abs(odds) < 100 || (line != null && !Number.isFinite(line))) continue;
    const pick = await env.DB.prepare("SELECT selection, market, side, start_at FROM picks WHERE id = ? AND status = 'pending'")
      .bind(pickId)
      .first<{ selection: string; market: string; side: string; start_at: number }>();
    if (!pick || pick.start_at <= now) continue;
    const follows = await env.DB.prepare('SELECT f.sub_id, f.odds, f.line FROM push_follows f JOIN push_subs s ON s.id = f.sub_id WHERE f.pick_id = ? AND s.pro_until > ?')
      .bind(pickId, now)
      .all<{ sub_id: string; odds: number; line: number | null }>();
    for (const f of follows.results) {
      const lineMoved = line != null && f.line != null && Math.abs(line - f.line) >= LINE_STEP;
      const priceMoved = Math.abs(breakEven(odds) - breakEven(f.odds)) >= PRICE_STEP;
      if (!lineMoved && !priceMoved) continue;
      // Better for whoever already holds the pick: the market now asks more for the same side.
      const better = lineMoved
        ? pick.market === 'spread'
          ? line! < f.line!
          : pick.side === 'over'
            ? line! > f.line!
            : line! < f.line!
        : breakEven(odds) > breakEven(f.odds);
      const now_ = line != null && pick.market !== 'ml' ? `${pick.market === 'spread' ? fmtLine(line) : line} at ${fmtOdds(odds)}` : fmtOdds(odds);
      const was = f.line != null && pick.market !== 'ml' ? `${pick.market === 'spread' ? fmtLine(f.line) : f.line} at ${fmtOdds(f.odds)}` : fmtOdds(f.odds);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO push_outbox (sub_id, created_at, title, body, url, tag) VALUES (?, ?, ?, ?, ?, ?)').bind(
          f.sub_id,
          now,
          `Line moved: ${pick.selection}`,
          `Now ${now_} at DraftKings (was ${was}). ${better ? 'The market moved toward this pick.' : 'The market moved away from this pick.'}`,
          appUrl + '#record',
          `move-${pickId}`
        ),
        env.DB.prepare('UPDATE push_follows SET odds = ?, line = ? WHERE sub_id = ? AND pick_id = ?').bind(odds, line, f.sub_id, pickId),
      ]);
      queued++;
    }
  }
  return json({ queued });
}

// ---------- sending ----------

/** A signed VAPID token per push service, reused for every push to it in one run. */
async function vapidHeader(env: Env, endpoint: string, now: number, cache: Map<string, string>) {
  const aud = new URL(endpoint).origin;
  const hit = cache.get(aud);
  if (hit) return hit;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK!);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.APP_URL || 'mailto:alerts@example.com' })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body)));
  const header = `vapid t=${body}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
  cache.set(aud, header);
  return header;
}

/** Queue alerts for picks posted since the last run (none on the very first run, so nobody gets a backlog). */
async function queueNewPicks(env: Env, now: number) {
  const max = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM picks').first<{ seq: number }>();
  const state = await env.DB.prepare("SELECT value FROM push_state WHERE key = 'last_seq'").first<{ value: string }>();
  const top = max?.seq ?? 0;
  if (state) {
    const fresh = await env.DB.prepare('SELECT id, selection, odds, matchup, author, start_at FROM picks WHERE seq > ? AND start_at > ? ORDER BY seq')
      .bind(Number(state.value), now)
      .all<{ id: string; selection: string; odds: number; matchup: string; author: string; start_at: number }>();
    const appUrl = (env.APP_URL || '').replace(/#.*$/, '');
    for (const p of fresh.results) {
      const when = new Date(p.start_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
      await env.DB.prepare(
        `INSERT INTO push_outbox (sub_id, created_at, title, body, url, tag)
         SELECT id, ?, ?, ?, ?, ? FROM push_subs WHERE picks = 1 AND pro_until > ?`
      )
        .bind(now, p.author === 'model' ? 'New Birdman model pick' : 'New Birdman pick', `${p.selection} ${fmtOdds(p.odds)} · ${p.matchup}, ${when} ET`, appUrl + '#record', `pick-${p.id}`, now)
        .run();
    }
  }
  await env.DB.prepare("INSERT INTO push_state (key, value) VALUES ('last_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(top)).run();
}

/** Run by the 5-minute cron: tidy up, queue new-pick alerts and wake the phones that have mail. */
export async function sendPushes(env: Env, deps: Deps, send: typeof fetch = fetch) {
  const now = deps.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_outbox WHERE created_at < ? OR sub_id NOT IN (SELECT id FROM push_subs)').bind(now - OUTBOX_TTL_MS),
    env.DB.prepare('DELETE FROM push_follows WHERE sub_id NOT IN (SELECT id FROM push_subs) OR pick_id NOT IN (SELECT id FROM picks WHERE status = ?)').bind('pending'),
    env.DB.prepare('DELETE FROM push_subs WHERE seen_at < ?').bind(now - SUB_TTL_MS),
  ]);
  await queueNewPicks(env, now);
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return { sent: 0, gone: 0 };
  const due = await env.DB.prepare(
    `SELECT s.id, s.endpoint, s.fails FROM push_subs s WHERE s.pro_until > ? AND EXISTS (SELECT 1 FROM push_outbox o WHERE o.sub_id = s.id AND o.sent = 0) LIMIT ?`
  )
    .bind(now, SENDS_PER_RUN)
    .all<{ id: string; endpoint: string; fails: number }>();
  const cache = new Map<string, string>();
  let sent = 0;
  let gone = 0;
  for (const s of due.results) {
    let status = 0;
    try {
      const res = await send(s.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(env, s.endpoint, now, cache), TTL: '21600', Urgency: 'high', 'Content-Length': '0' },
      });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      sent++;
      await env.DB.batch([
        env.DB.prepare('UPDATE push_outbox SET sent = 1 WHERE sub_id = ?').bind(s.id),
        env.DB.prepare('UPDATE push_subs SET fails = 0 WHERE id = ?').bind(s.id),
      ]);
    } else if (status === 404 || status === 410 || s.fails >= 4) {
      gone++;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM push_outbox WHERE sub_id = ?').bind(s.id),
        env.DB.prepare('DELETE FROM push_follows WHERE sub_id = ?').bind(s.id),
        env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id),
      ]);
    } else await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE id = ?').bind(s.id).run();
  }
  return { sent, gone };
}
