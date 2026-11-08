// Run with: npm test (from server/). Builds the worker with esbuild, then exercises it against SQLite.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDB } from './d1shim.mjs';
import { pathToFileURL } from 'node:url';

const W = await import(pathToFileURL(process.env.WORKER_BUNDLE).href);
const { handle, settleAll } = W;
const { pickHash, lockedFields, GENESIS } = W;

const ORIGIN = 'https://robdv081.github.io';
const ADMIN = 'owner-key-0123456789abcdef';
const AGENT = 'agent-key-0123456789abcdef';
const T0 = Date.parse('2026-11-08T15:00:00Z'); // Sunday 10am ET
let env, deps, clock, games, gradeResults, closeResults;

const game = (id, over = {}) => ({
  id,
  league: 'nfl',
  start: '2026-11-08T18:00:00Z',
  state: 'pre',
  completed: false,
  detail: '1:00 PM',
  away: { id: '1', abbr: 'KC', name: 'Kansas City Chiefs', score: null },
  home: { id: '2', abbr: 'BUF', name: 'Buffalo Bills', score: null },
  ...over,
});

beforeEach(() => {
  clock = T0;
  games = { 'nfl|2026-11-08': [game('401'), game('402', { away: { id: '3', abbr: 'DAL', name: 'Dallas', score: null }, home: { id: '4', abbr: 'NYG', name: 'Giants', score: null } })] };
  gradeResults = new Map();
  closeResults = new Map();
  env = { DB: makeDB(new URL('../schema.sql', import.meta.url)), ALLOWED_ORIGIN: ORIGIN, ADMIN_KEY: ADMIN, AGENT_KEY: AGENT };
  deps = {
    now: () => clock,
    games: async (lg, date) => structuredClone(games[`${lg}|${date}`] ?? []),
    grade: async (bets) => new Map([...gradeResults].filter(([id]) => bets.some((b) => b.id === id))),
    closes: async (bets) => new Map([...closeResults].filter(([id]) => bets.some((b) => b.id === id))),
  };
});

async function call(method, path, body, headers = {}) {
  const res = await handle(
    new Request('https://srv.example' + path, {
      method,
      headers: { Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    deps
  );
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
const owner = { Authorization: 'Bearer ' + ADMIN };
const pick = (over = {}) => ({ league: 'nfl', eventId: '401', date: '2026-11-08', market: 'spread', side: 'away', line: 2.5, odds: -110, units: 1, reason: 'KC is 7-1 ATS as a road dog.', ...over });

// ---------- record ----------

test('owner posts a pick; server stamps time, builds the label and hash', async () => {
  const r = await call('POST', '/api/record/picks', pick(), owner);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = r.body.pick;
  assert.equal(p.selection, 'KC +2.5');
  assert.equal(p.matchup, 'KC @ BUF');
  assert.equal(p.createdAt, T0);
  assert.equal(p.startAt, Date.parse('2026-11-08T18:00:00Z'));
  assert.equal(p.prevHash, GENESIS);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('only the owner can post', async () => {
  assert.equal((await call('POST', '/api/record/picks', pick())).status, 401);
  assert.equal((await call('POST', '/api/record/picks', pick(), { Authorization: 'Bearer nope' })).status, 401);
  env.ADMIN_KEY = 'short';
  assert.equal((await call('POST', '/api/record/picks', pick(), { Authorization: 'Bearer short' })).status, 401, 'weak keys are refused');
});

test('picks lock at kickoff, judged by the server clock and ESPN state', async () => {
  clock = Date.parse('2026-11-08T18:00:01Z');
  assert.equal((await call('POST', '/api/record/picks', pick(), owner)).status, 409);
  clock = T0;
  games['nfl|2026-11-08'][0].state = 'in';
  assert.equal((await call('POST', '/api/record/picks', pick(), owner)).status, 409);
});

test('bad picks are refused', async () => {
  for (const bad of [
    { eventId: '999' },
    { market: 'parlay' },
    { side: 'over' },
    { odds: -50 },
    { units: 50 },
    { line: null },
    { market: 'ml', side: 'draw' },
    { league: 'pga' },
    { eventId: '../x' },
  ]) {
    const r = await call('POST', '/api/record/picks', pick(bad), owner);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(bad)} -> ${r.status}`);
  }
});

test('the public record chains hashes and anyone can recheck them', async () => {
  await call('POST', '/api/record/picks', pick(), owner);
  await call('POST', '/api/record/picks', pick({ eventId: '402', market: 'ml', side: 'home', odds: 135, line: null, reason: '' }), owner);
  await call('POST', '/api/record/picks', pick({ eventId: '402', market: 'total', side: 'under', line: 41.5, odds: -105 }), owner);
  const r = await call('GET', '/api/record');
  assert.equal(r.status, 200);
  const list = [...r.body.picks].reverse();
  assert.deepEqual(list.map((p) => p.seq), [1, 2, 3]);
  assert.equal(list[1].selection, 'NYG ML');
  assert.equal(list[2].selection, 'DAL @ NYG Under 41.5');
  let prev = GENESIS;
  for (const p of list) {
    assert.equal(p.prevHash, prev);
    const row = { seq: p.seq, id: p.id, created_at: p.createdAt, start_at: p.startAt, league: p.league, event_id: p.eventId, date: p.date, matchup: p.matchup,
      market: p.market, side: p.side, line: p.line, odds: p.odds, selection: p.selection, player: p.player, stat: p.stat, units: p.units, reason: p.reason, author: p.author };
    assert.equal(await pickHash(prev, row), p.hash);
    prev = p.hash;
  }
  // Editing a pick after the fact breaks its hash.
  env.DB.raw.exec("UPDATE picks SET odds = 200 WHERE seq = 1");
  const after = [...(await call('GET', '/api/record')).body.picks].reverse()[0];
  const row = { ...after, created_at: after.createdAt, start_at: after.startAt, event_id: after.eventId };
  assert.notEqual(await pickHash(GENESIS, row), after.hash);
  assert.ok(lockedFields(row).includes('200'));
});

test('there is no way to delete or edit a pick through the server', async () => {
  await call('POST', '/api/record/picks', pick(), owner);
  for (const m of ['DELETE', 'PUT', 'PATCH']) {
    const r = await call(m, '/api/record/picks', pick(), owner);
    assert.ok([403, 404, 405].includes(r.status), `${m} -> ${r.status}`);
  }
});

test('scheduled job records the close, grades, and the summary adds up', async () => {
  const a = (await call('POST', '/api/record/picks', pick(), owner)).body.pick;
  const b = (await call('POST', '/api/record/picks', pick({ eventId: '402', market: 'ml', side: 'home', odds: 135, line: null }), owner)).body.pick;
  closeResults.set(a.id, { closeOdds: -125, closeLine: 2.5, closeChecked: true }); // got -110, closed -125: beat it
  closeResults.set(b.id, { closeOdds: 150, closeChecked: true }); // got +135, closed +150: didn't
  gradeResults.set(a.id, { status: 'won', finalScore: 'KC 24 – BUF 20', margin: 6.5 });
  gradeResults.set(b.id, { status: 'lost', finalScore: 'DAL 27 – NYG 10', margin: -17 });

  clock = T0 - 1000; // before kickoff: nothing to do
  assert.deepEqual((await settleAll(env, deps)).record, { closed: 0, graded: 0 });
  clock = Date.parse('2026-11-08T22:00:00Z');
  assert.deepEqual((await settleAll(env, deps)).record, { closed: 2, graded: 2 });
  assert.deepEqual((await settleAll(env, deps)).record, { closed: 0, graded: 0 }, 'settled picks are left alone');

  const r = await call('GET', '/api/record');
  const s = r.body.summary;
  assert.deepEqual([s.won, s.lost, s.push, s.pending], [1, 1, 0, 0]);
  assert.equal(s.units, Math.round((1 * (100 / 110) - 1) * 100) / 100);
  assert.deepEqual([s.clvBeat, s.clvMeasured], [1, 2]);
  const ga = r.body.picks.find((p) => p.id === a.id);
  assert.equal(ga.finalScore, 'KC 24 – BUF 20');
  assert.equal(ga.closeOdds, -125);
  // Grading never changes the hash.
  assert.equal(ga.hash, a.hash);
});

test('owner key check', async () => {
  assert.equal((await call('GET', '/api/record/owner', null, owner)).status, 200);
  assert.equal((await call('GET', '/api/record/owner', null, { Authorization: 'Bearer wrong-key-0123456789' })).status, 401);
});

test('the pick agent posts with its own key; its picks are marked as the model\'s, and it cannot pass as the owner', async () => {
  const r = await call('POST', '/api/record/picks', pick(), { Authorization: 'Bearer ' + AGENT });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pick.author, 'model');
  const o = await call('POST', '/api/record/picks', pick({ eventId: '402', market: 'ml', side: 'home', odds: 135, line: null }), owner);
  assert.equal(o.body.pick.author, 'owner');
  assert.equal((await call('GET', '/api/record/owner', null, { Authorization: 'Bearer ' + AGENT })).status, 401);
  const list = (await call('GET', '/api/record')).body.picks;
  assert.deepEqual(list.map((p) => p.author), ['owner', 'model']);
});

// ---------- pick'em ----------

async function makePool() {
  const c = await call('POST', '/api/pools', { name: 'Sunday crew', league: 'nfl', player: 'Rob' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const j = await call('POST', '/api/pools/join', { code: c.body.code.toLowerCase(), player: 'Hin' });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  return { code: c.body.code, rob: { 'X-Pool-Token': c.body.token }, hin: { 'X-Pool-Token': j.body.token } };
}

test('make and join a pool; names are unique per pool', async () => {
  const { code } = await makePool();
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal((await call('POST', '/api/pools/join', { code, player: 'hin' })).status, 409);
  assert.equal((await call('POST', '/api/pools/join', { code: 'ZZZZZZ', player: 'X' })).status, 404);
  assert.equal((await call('POST', '/api/pools', { league: 'pga', player: 'X' })).status, 400);
  assert.equal((await call('POST', '/api/pools', { league: 'nfl', player: '  ' })).status, 400);
});

test('pick, change your mind, then lock at kickoff', async () => {
  const { code, rob } = await makePool();
  assert.equal((await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'home' }, rob)).status, 200);
  assert.equal((await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'away' }, rob)).status, 200);
  const g = await call('GET', `/api/pools/${code}?date=2026-11-08`, null, rob);
  assert.deepEqual(g.body.mine['401'], { side: 'away', result: null });
  assert.equal((await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'draw' }, rob)).status, 400, 'no draws in the NFL');
  clock = Date.parse('2026-11-08T18:00:00Z');
  assert.equal((await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'home' }, rob)).status, 409);
});

test("others' picks stay hidden until the game starts", async () => {
  const { code, rob, hin } = await makePool();
  await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'home' }, hin);
  let g = await call('GET', `/api/pools/${code}?date=2026-11-08`, null, rob);
  assert.deepEqual(g.body.revealed, {});
  clock = Date.parse('2026-11-08T18:05:00Z');
  g = await call('GET', `/api/pools/${code}?date=2026-11-08`, null, rob);
  assert.deepEqual(g.body.revealed['401'].map((e) => [e.name, e.label]), [['Hin', 'BUF']]);
});

test('pools need a member token, and tokens only open their own pool', async () => {
  const a = await makePool();
  const b = await makePool();
  assert.equal((await call('GET', `/api/pools/${a.code}`)).status, 401);
  assert.equal((await call('GET', `/api/pools/${a.code}`, null, b.rob)).status, 401);
  assert.equal((await call('PUT', `/api/pools/${a.code}/picks`, { eventId: '401', date: '2026-11-08', side: 'home' }, b.hin)).status, 401);
});

test('finished games grade every pick; leaderboard counts week and all time', async () => {
  const { code, rob, hin } = await makePool();
  await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'away' }, rob);
  await call('PUT', `/api/pools/${code}/picks`, { eventId: '402', date: '2026-11-08', side: 'home' }, rob);
  await call('PUT', `/api/pools/${code}/picks`, { eventId: '401', date: '2026-11-08', side: 'home' }, hin);
  clock = Date.parse('2026-11-08T22:00:00Z');
  const [g1, g2] = games['nfl|2026-11-08'];
  Object.assign(g1, { state: 'post', completed: true, away: { ...g1.away, score: 24 }, home: { ...g1.home, score: 20 } });
  Object.assign(g2, { state: 'post', completed: true, away: { ...g2.away, score: 17 }, home: { ...g2.home, score: 17 } }); // NFL tie: no winner
  await settleAll(env, deps);
  const g = await call('GET', `/api/pools/${code}?date=2026-11-08`, null, hin);
  const st = Object.fromEntries(g.body.standings.map((s) => [s.name, s]));
  assert.deepEqual(st.Rob.all, { right: 1, wrong: 0 });
  assert.deepEqual(st.Hin.all, { right: 0, wrong: 1 });
  assert.deepEqual(st.Rob.week, { right: 1, wrong: 0 });
  assert.equal(g.body.weekStart, '2026-11-02');
  assert.equal(g.body.revealed['402'][0].result, 'void');
  // A week later, last week's points drop off the weekly board but stay on all-time.
  clock = Date.parse('2026-11-16T15:00:00Z');
  const later = await call('GET', `/api/pools/${code}`, null, rob);
  const me = later.body.standings.find((s) => s.me);
  assert.deepEqual([me.week, me.all], [{ right: 0, wrong: 0 }, { right: 1, wrong: 0 }]);
});

// ---------- plumbing ----------

test('CORS: the app is allowed, other sites are not', async () => {
  const ok = await handle(new Request('https://srv.example/api/record', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, deps);
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /X-Pool-Token/);
  const bad = await handle(new Request('https://srv.example/api/record', { headers: { Origin: 'https://evil.example' } }), env, deps);
  assert.equal(bad.status, 403);
});

test('Pro routes say so plainly when Stripe is not set up', async () => {
  const r = await call('GET', '/api/pro/status');
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Pro isn't set up/);
});

test('unreadable or oversized bodies get a clean error', async () => {
  const res = await handle(new Request('https://srv.example/api/pools', { method: 'POST', headers: { Origin: ORIGIN }, body: '{oops' }), env, deps);
  assert.equal(res.status, 400);
  const big = await call('POST', '/api/pools', { name: 'x'.repeat(9000), league: 'nfl', player: 'a' });
  assert.equal(big.status, 413);
});

// ---------- Pro (Stripe and email faked) ----------

function fakeStripe() {
  const emails = [];
  const subs = { cus_A: [{ status: 'active', current_period_end: 1800000000 }] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (s, b) => new Response(JSON.stringify(b), { status: s });
    if (u.host === 'api.resend.com') {
      emails.push(JSON.parse(init.body));
      return reply(200, {});
    }
    if (u.pathname === '/v1/checkout/sessions/cs_test_paidsession123') return reply(200, { status: 'complete', payment_status: 'paid', customer: 'cus_A' });
    if (u.pathname.startsWith('/v1/checkout/sessions/')) return reply(404, { error: { message: 'none' } });
    if (u.pathname === '/v1/subscriptions') return reply(200, { data: subs[u.searchParams.get('customer')] ?? [] });
    if (u.pathname === '/v1/customers') return reply(200, { data: u.searchParams.get('email') === 'fan@example.com' ? [{ id: 'cus_A' }] : [] });
    if (u.pathname === '/v1/billing_portal/sessions') return reply(200, { url: 'https://billing.stripe.com/p/x' });
    return reply(500, { error: { message: 'unexpected' } });
  };
  Object.assign(env, { STRIPE_SECRET_KEY: 'sk_test_x', TOKEN_SECRET: 'tok-secret', RESEND_API_KEY: 're_x', FROM_EMAIL: 'Birdman <pro@example.com>' });
  return { emails, subs };
}

test('Pro: checkout claim, status, lapse and billing portal', async () => {
  const { subs } = fakeStripe();
  const c = await call('POST', '/api/pro/claim', { session_id: 'cs_test_paidsession123' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const auth = { Authorization: 'Bearer ' + c.body.token };
  assert.equal((await call('GET', '/api/pro/status', null, auth)).body.pro, true);
  assert.equal((await call('POST', '/api/pro/portal', {}, auth)).body.url, 'https://billing.stripe.com/p/x');
  assert.equal((await call('POST', '/api/pro/claim', { session_id: 'cs_test_nosuchsession99' })).status, 404);
  assert.equal((await call('GET', '/api/pro/status', null, { Authorization: 'Bearer ' + c.body.token.replace(/.$/, 'x') })).status, 401);
  subs.cus_A = [{ status: 'canceled' }];
  assert.equal((await call('GET', '/api/pro/status', null, auth)).body.pro, false);
});

test('Pro: restore by emailed code, rate limited, codes burn out', async () => {
  const { emails } = fakeStripe();
  assert.equal((await call('POST', '/api/pro/restore/start', { email: 'nobody@example.com' })).body.sent, true);
  assert.equal(emails.length, 0, 'no email for non-subscribers, same reply');
  await call('POST', '/api/pro/restore/start', { email: ' Fan@Example.com ' });
  await call('POST', '/api/pro/restore/start', { email: 'fan@example.com' });
  assert.equal(emails.length, 1, 'second request within a minute sends nothing');
  const code = emails[0].subject.match(/(\d{6})$/)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/api/pro/restore/verify', { email: 'fan@example.com', code: wrong })).status, 400);
  const ok = await call('POST', '/api/pro/restore/verify', { email: 'fan@example.com', code });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await call('POST', '/api/pro/restore/verify', { email: 'fan@example.com', code })).status, 400, 'codes work once');
  // Five wrong tries kill a code.
  clock += 120_000;
  await call('POST', '/api/pro/restore/start', { email: 'fan@example.com' });
  const code2 = emails[1].subject.match(/(\d{6})$/)[1];
  const wrong2 = code2 === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await call('POST', '/api/pro/restore/verify', { email: 'fan@example.com', code: wrong2 });
  assert.equal((await call('POST', '/api/pro/restore/verify', { email: 'fan@example.com', code: code2 })).status, 400);
  // Codes expire after 10 minutes.
  clock += 120_000;
  await call('POST', '/api/pro/restore/start', { email: 'fan@example.com' });
  const code3 = emails[2].subject.match(/(\d{6})$/)[1];
  clock += 11 * 60_000;
  assert.equal((await call('POST', '/api/pro/restore/verify', { email: 'fan@example.com', code: code3 })).status, 400);
});

// ---------- Scout + Birdman Analyst ----------
const iso = (ms) => new Date(ms).toISOString();
const SCOUT = { Authorization: 'Bearer test-scout-key-0123' };
const ev = (kind, over = {}) => ({ kind, url: 'https://www.espn.com/nfl/game/_/gameId/401', checkedAt: iso(T0 - 5 * 60_000), note: kind + ' checked', ...over });
const analystPick = (over = {}) => ({
  league: 'nfl', eventId: '401', start: '2026-11-08T18:00:00Z', event: 'Kansas City Chiefs at Buffalo Bills',
  market: 'KC +2.5', odds: -110, bookmaker: 'DraftKings', probability: 0.58,
  method: 'ESPN FPI projection blended with the DraftKings price.',
  availability: 'Checked against ESPN’s injury report.',
  evidence: [ev('schedule'), ev('odds', { url: 'https://sportsbook.draftkings.com/event/401' }), ev('injuries', { url: 'https://www.espn.com/nfl/injuries' })],
  counterarguments: ['The market disagrees.'], passIf: ['Pass if the price is worse than -125.'], onRecord: false,
  breakEven: 0.01, edge: 0.9, // ignored: the server recomputes both
  ...over,
});
const submission = (over = {}) => ({
  checkedAt: iso(T0 - 5 * 60_000),
  feeds: [{ league: 'nfl', checkedAt: iso(T0 - 5 * 60_000), ok: true, events: 2, injuries: true }],
  games: [{ league: 'nfl', eventId: '401', start: '2026-11-08T18:00:00Z', matchup: 'KC @ BUF', url: 'https://www.espn.com/nfl/game/_/gameId/401', odds: 'DraftKings: KC +120 / BUF -140', moved: 'BUF spread opened -2, now -2.5', injuries: [{ team: 'KC', player: 'A Player', status: 'Out' }] }],
  candidates: [analystPick()],
  passes: [],
  ...over,
});
const publish = (body) => call('POST', '/api/scout/research', body, SCOUT);

test('Scout publishes with its own key only; the server recomputes break-even and edge', async () => {
  assert.equal((await publish(submission())).status, 401, 'no publisher connected');
  env.SCOUT_PUBLISH_KEY = 'test-scout-key-0123';
  assert.equal((await call('POST', '/api/scout/research', submission(), owner)).status, 401, 'the owner key is not the publisher key');
  const r = await publish(submission());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.report.status, 'paper_candidates');
  const row = JSON.parse(env.DB.raw.prepare('SELECT report FROM scout_reports').get().report);
  assert.ok(Math.abs(row.candidates[0].breakEven - 110 / 210) < 1e-9);
  assert.ok(Math.abs(row.candidates[0].edge - (0.58 - 110 / 210)) < 1e-9);
  assert.equal(row.games[0].injuries[0].player, 'A Player');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM picks').get().n, 0, 'research never touches the record');
});

test('Analyst passes picks with missing, stale or outside sources, started games and out-of-range edges', async () => {
  env.SCOUT_PUBLISH_KEY = 'test-scout-key-0123';
  const bad = [
    analystPick({ eventId: '402', evidence: [ev('schedule'), ev('odds', { url: 'https://example.com/odds' }), ev('injuries')] }),
    analystPick({ eventId: '402', evidence: [ev('schedule'), ev('odds'), ev('injuries', { checkedAt: iso(T0 - 40 * 60_000) })] }),
    analystPick({ eventId: '402', evidence: [ev('schedule'), ev('injuries')] }),
    analystPick({ eventId: '402', start: iso(T0 + 5 * 60_000) }),
    analystPick({ eventId: '402', probability: 0.75 }),
    analystPick({ eventId: '402', probability: 0.53 }),
    analystPick({ eventId: '402', odds: 99 }),
    analystPick({ eventId: '402', counterarguments: [] }),
  ];
  const r = await publish(submission({ candidates: bad }));
  assert.equal(r.status, 201);
  assert.equal(r.body.report.candidates, 0);
  assert.equal(r.body.report.status, 'no_verified_picks');
  assert.equal(r.body.report.passes.length, bad.length);
  const many = await publish(submission({ candidates: [analystPick(), analystPick(), analystPick({ eventId: '402' }), analystPick({ eventId: '403' }), analystPick({ eventId: '404' })] }));
  assert.equal(many.body.report.candidates, 3, 'three at most, one per game');
  assert.equal((await publish(submission({ checkedAt: iso(T0 - 25 * 60_000) }))).status, 400, 'old research is refused');
  assert.equal((await publish(submission({ checkedAt: iso(T0 + 5 * 60_000) }))).status, 400, 'future research is refused');
});

test('Pro members read the latest report; it hides picks near the start and when out of date', async () => {
  const { subs } = fakeStripe();
  env.SCOUT_PUBLISH_KEY = 'test-scout-key-0123';
  assert.equal((await call('GET', '/api/pro/scout')).status, 401);
  await publish(submission());
  const c = await call('POST', '/api/pro/claim', { session_id: 'cs_test_paidsession123' });
  const auth = { Authorization: 'Bearer ' + c.body.token };
  const r = await call('GET', '/api/pro/scout', null, auth);
  assert.equal(r.body.report.candidates.length, 1);
  assert.equal(r.body.report.games.length, 1);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  clock = Date.parse('2026-11-08T17:55:00Z');
  const late = await call('GET', '/api/pro/scout', null, auth);
  assert.equal(late.body.expired, true);
  assert.equal(late.body.report.candidates.length, 0);
  clock = Date.parse('2026-11-08T17:00:00Z');
  await publish(submission({ checkedAt: iso(clock - 60_000), candidates: [analystPick({ evidence: [ev('schedule', { checkedAt: iso(clock - 60_000) }), ev('odds', { checkedAt: iso(clock - 60_000) }), ev('stats', { checkedAt: iso(clock - 60_000) })] })] }));
  clock = Date.parse('2026-11-08T17:45:00Z');
  assert.equal((await call('GET', '/api/pro/scout', null, auth)).body.report.candidates.length, 1, 'fresh report, 15 minutes out');
  clock = Date.parse('2026-11-08T17:52:00Z');
  const near = await call('GET', '/api/pro/scout', null, auth);
  assert.equal(near.body.expired, false);
  assert.equal(near.body.report.candidates.length, 0, 'within 10 minutes of the start');
  subs.cus_A = [{ status: 'canceled' }];
  assert.equal((await call('GET', '/api/pro/scout', null, auth)).status, 403);
});

test('the app can see whether Scout is connected', async () => {
  assert.equal((await call('GET', '/api/scout/enabled')).body.enabled, false);
  env.SCOUT_PUBLISH_KEY = 'test-scout-key-0123';
  assert.equal((await call('GET', '/api/scout/enabled')).body.enabled, true);
});

// ---------- Pro alerts ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
async function vapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  env.VAPID_PUBLIC_KEY = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
  env.APP_URL = 'https://robdv081.github.io/birdman-picks/';
  return kp.publicKey;
}
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', auth: 'c2VjcmV0LWF1dGgtMTIzNA' };
async function proMember() {
  const stripe = fakeStripe();
  const c = await call('POST', '/api/pro/claim', { session_id: 'cs_test_paidsession123' });
  return { ...stripe, auth: { Authorization: 'Bearer ' + c.body.token } };
}

test('alerts: only Pro members on a known push service can subscribe; the phone proves itself to collect', async () => {
  const { auth, subs } = await proMember();
  assert.equal((await call('POST', '/api/push/subscribe', SUB, auth)).status, 503, 'needs keys on the server');
  await vapid();
  assert.equal((await call('GET', '/api/push/key')).body.key, env.VAPID_PUBLIC_KEY);
  assert.equal((await call('POST', '/api/push/subscribe', SUB)).status, 401);
  assert.equal((await call('POST', '/api/push/subscribe', { ...SUB, endpoint: 'https://evil.example/push' }, auth)).status, 400);
  assert.equal((await call('POST', '/api/push/subscribe', SUB, auth)).status, 200);
  assert.equal((await call('POST', '/api/push/pull', { ...SUB, auth: 'wrong-secret-wrong-secret' })).status, 404);
  assert.deepEqual((await call('POST', '/api/push/pull', SUB)).body.messages, []);
  subs.cus_A = [{ status: 'canceled' }];
  assert.equal((await call('POST', '/api/push/subscribe', SUB, auth)).status, 403, 'lapsed members cannot re-subscribe');
});

test('alerts: a new pick wakes subscribed phones with a signed VAPID push, and the message is collected once', async () => {
  const { auth } = await proMember();
  const pub = await vapid();
  await call('POST', '/api/push/subscribe', SUB, auth);
  await W.sendPushes(env, deps, async () => new Response(null, { status: 201 })); // first run: baseline, no backlog
  await call('POST', '/api/record/picks', pick(), { Authorization: 'Bearer ' + AGENT });
  const sent = [];
  const r = await W.sendPushes(env, deps, async (url, init) => (sent.push({ url, init }), new Response(null, { status: 201 })));
  assert.equal(r.sent, 1);
  assert.equal(sent[0].url, SUB.endpoint);
  assert.equal(sent[0].init.headers['Content-Length'], '0', 'pushes carry no data');
  const m = sent[0].init.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, sent[0].init.headers.Authorization);
  assert.equal(JSON.parse(Buffer.from(m[2], 'base64url')).aud, 'https://fcm.googleapis.com');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), new TextEncoder().encode(`${m[1]}.${m[2]}`)), 'signature checks out');
  const got = await call('POST', '/api/push/pull', SUB);
  assert.equal(got.body.messages.length, 1);
  assert.equal(got.body.messages[0].title, 'New Birdman model pick');
  assert.match(got.body.messages[0].body, /KC \+2\.5 -110/);
  assert.equal((await call('POST', '/api/push/pull', SUB)).body.messages.length, 0, 'collected once');
  assert.equal((await W.sendPushes(env, deps, async () => new Response(null, { status: 201 }))).sent, 0, 'nothing new, no push');
  // Membership lapses (the app hasn't re-confirmed a renewal): no more alerts.
  env.DB.raw.prepare('UPDATE push_subs SET pro_until = ?').run(deps.now() - 1);
  assert.equal((await call('POST', '/api/record/picks', pick({ eventId: '402' }), { Authorization: 'Bearer ' + AGENT })).status, 201);
  assert.equal((await W.sendPushes(env, deps, async () => new Response(null, { status: 201 }))).sent, 0, 'lapsed: no push');
});

test('alerts: followers hear about real line moves, in plain words; dead subscriptions are dropped', async () => {
  const { auth } = await proMember();
  await vapid();
  await call('POST', '/api/push/subscribe', { ...SUB, picks: false }, auth);
  const p = (await call('POST', '/api/record/picks', pick(), owner)).body.pick; // KC +2.5 -110
  assert.equal((await call('POST', '/api/push/follow', { ...SUB, pickId: p.id })).body.following, true);
  assert.equal((await call('POST', '/api/push/moves', { moves: [] })).status, 401, 'only the publisher reports prices');
  env.SCOUT_PUBLISH_KEY = 'test-scout-key-0123';
  const move = (odds, line) => call('POST', '/api/push/moves', { moves: [{ pickId: p.id, odds, line }] }, SCOUT);
  assert.equal((await move(-112, 2.5)).body.queued, 0, 'a cent or two is not news');
  assert.equal((await move(-110, 1.5)).body.queued, 1);
  const msg = (await call('POST', '/api/push/pull', SUB)).body.messages[0];
  assert.equal(msg.title, 'Line moved: KC +2.5');
  assert.match(msg.body, /Now \+1\.5 at -110 .*was \+2\.5 at -110.*toward this pick/);
  assert.equal((await move(-110, 1.5)).body.queued, 0, 'no repeat for the same number');
  assert.equal((await move(-110, 3)).body.queued, 1);
  assert.match((await call('POST', '/api/push/pull', SUB)).body.messages[0].body, /away from this pick/);
  await move(-110, 1.5);
  const r = await W.sendPushes(env, deps, async () => new Response(null, { status: 410 }));
  assert.equal(r.gone, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM push_follows').get().n, 0);
});

test('the cron starts the pick agent and Scout on GitHub at their Eastern times, only with a token', async () => {
  const at = (iso) => Date.parse(iso);
  // Nov 8 2026 is EST (UTC-5).
  assert.deepEqual(W.dueJobs(at('2026-11-08T17:15:30Z')), ['agent.yml'], '12:15 PM ET');
  assert.deepEqual(W.dueJobs(at('2026-11-08T17:05:00Z')), ['scout.yml'], '12:05 PM ET');
  assert.deepEqual(W.dueJobs(at('2026-11-09T00:15:00Z')), ['agent.yml'], '7:15 PM ET');
  assert.deepEqual(W.dueJobs(at('2026-11-08T22:35:00Z')), ['scout.yml'], '5:35 PM ET');
  assert.deepEqual(W.dueJobs(at('2026-11-08T17:20:00Z')), []);
  assert.deepEqual(W.dueJobs(at('2026-11-08T08:05:00Z')), [], '3 AM ET: nothing');
  assert.deepEqual(W.dueJobs(at('2026-07-08T16:15:00Z')), ['agent.yml'], 'summer time (UTC-4) too');
  const calls = [];
  const send = async (url, init) => (calls.push({ url, init }), new Response(null, { status: 204 }));
  assert.equal((await W.dispatchJobs({}, at('2026-11-08T17:15:00Z'), send)).skipped, 'no token');
  assert.equal(calls.length, 0);
  const r = await W.dispatchJobs({ GH_DISPATCH_TOKEN: 'github_pat_test' }, at('2026-11-08T17:15:00Z'), send);
  assert.deepEqual(r.started, ['agent.yml']);
  assert.equal(calls[0].url, 'https://api.github.com/repos/robdv081/birdman-picks/actions/workflows/agent.yml/dispatches');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer github_pat_test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
  const bad = await W.dispatchJobs({ GH_DISPATCH_TOKEN: 'x' }, at('2026-11-08T17:15:00Z'), async () => new Response('{}', { status: 401 }));
  assert.deepEqual(bad.failed, ['agent.yml (401)']);
});

test("owner pass: the owner's key unlocks Pro research and alerts without a subscription; other keys don't", async () => {
  env.SCOUT_PUBLISH_KEY = 'test-scout-key-0123';
  const st = await call('GET', '/api/pro/status', undefined, owner);
  assert.equal(st.status, 200);
  assert.equal(st.body.pro, true);
  assert.equal(st.body.owner, true);
  assert.equal((await call('GET', '/api/pro/scout', undefined, owner)).status, 200);
  assert.equal((await call('GET', '/api/pro/scout', undefined, { Authorization: 'Bearer ' + AGENT })).status, 503, 'the agent key is not a Pro pass');
  assert.equal((await call('GET', '/api/pro/status', undefined, { Authorization: 'Bearer not-the-owner-key-123' })).body.owner, undefined);
});
