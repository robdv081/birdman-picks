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

// ---------- Scout v2 / Analyst v1 ----------
const researchMarket = (over = {}) => ({
  league: 'nfl', eventId: '401', start: '2026-11-08T18:00:00Z', market: 'Kansas City +2.5',
  odds: -110, bookmaker: 'Example book', availabilityConfirmed: true,
  counterarguments: 'Road travel and a changed offensive line can reduce the estimate.',
  passIf: 'Pass if the quarterback is unavailable or the price moves.',
  evidence: [
    {kind:'official', url:'https://www.nfl.com/injuries/', checkedAt:new Date(T0).toISOString(), note:'Official availability checked.'},
    {kind:'bookmaker', url:'https://example.com/markets/401', checkedAt:new Date(T0).toISOString(), note:'Book price observed.'}
  ],
  estimate: {probability:0.58, method:'Independent example model trained on pregame team statistics.', validation:'Example held-out calibration assessment with recorded sample size.', source:'https://example.com/model-validation'},
  ...over
});
test('Scout accepts a documented future market; Analyst computes break-even and flat units', async () => {
  const r = await W.research(env, deps, [researchMarket()]);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].units, 1);
  assert.ok(Math.abs(r.candidates[0].breakEven - 110/210) < 1e-9);
  assert.equal(r.feeds.length, 1, 'only the leagues being researched are downloaded');
});
test('Scout rejects stale, future-dated, forged official and missing-price evidence', async () => {
  for (const bad of [
    researchMarket({odds:99}),
    researchMarket({evidence:researchMarket().evidence.map(e=>({...e,checkedAt:new Date(T0-31*60000).toISOString()}))}),
    researchMarket({evidence:researchMarket().evidence.map(e=>({...e,checkedAt:new Date(T0+1).toISOString()}))}),
    researchMarket({evidence:researchMarket().evidence.map(e=>({...e,url:'https://nfl.com.evil.example/fake'}))}),
    researchMarket({availabilityConfirmed:false}), researchMarket({estimate:undefined})
  ]) assert.equal((await W.research(env,deps,[bad])).candidates.length,0);
});
test('Scout rejects changed starts and in-progress events', async () => {
  assert.equal((await W.research(env,deps,[researchMarket({start:'2026-11-08T18:01:00Z'})])).candidates.length,0);
  games['nfl|2026-11-08'][0].state='in';
  assert.equal((await W.research(env,deps,[researchMarket()])).candidates.length,0);
});
test('Analyst selects at most one candidate per event and passes missing estimates', async () => {
  const r=await W.research(env,deps,[researchMarket(),researchMarket(),researchMarket({estimate:undefined})]);
  assert.equal(r.candidates.length,1);
  assert.equal(r.passes.length,2);
});
test('Feed failure stays stale and does not become an empty successful check', async () => {
  deps.games=async()=>{throw Error('offline')};
  const r=await W.research(env,deps,[researchMarket()]);
  assert.equal(r.candidates.length,0);assert.ok(r.feeds.every(f=>f.stale));
});
test('Research publisher requires a separate key; reports append without touching the record', async () => {
  assert.equal((await call('POST','/api/scout/research',{markets:[]},owner)).status,401);
  env.SCOUT_PUBLISH_KEY='test-scout-key';
  const headers={Authorization:'Bearer test-scout-key'};
  assert.equal((await call('POST','/api/scout/research',{markets:[researchMarket()]},headers)).status,201);
  assert.equal((await call('POST','/api/scout/research',{markets:[]},headers)).status,201);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM scout_reports').get().n,2);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM picks').get().n,0);
});
test('An empty report downloads no schedules; the app can see whether a publisher is connected', async () => {
  let calls = 0; const real = deps.games; deps.games = async (...a) => (calls++, real(...a));
  const r = await W.research(env, deps, []);
  assert.equal(calls, 0); assert.equal(r.feeds.length, 0); assert.equal(r.status, 'no_verified_picks');
  delete env.SCOUT_PUBLISH_KEY;
  assert.equal((await call('GET', '/api/scout/enabled')).body.enabled, false);
  env.SCOUT_PUBLISH_KEY = 'test-scout-key';
  assert.equal((await call('GET', '/api/scout/enabled')).body.enabled, true);
});
test('Pro research fails closed with no membership; cron preserves a fresh published report', async () => {
  env.STRIPE_SECRET_KEY='test';env.TOKEN_SECRET='test-token-secret';
  assert.equal((await call('GET','/api/pro/scout')).status,401);
  env.SCOUT_PUBLISH_KEY='test-scout-key';
  await call('POST','/api/scout/research',{markets:[]},{Authorization:'Bearer test-scout-key'});
  await W.refreshResearch(env,deps);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM scout_reports').get().n,1);
  clock+=31*60000;await W.refreshResearch(env,deps);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM scout_reports').get().n,2);
});
test('Pro report access rechecks subscription, schedule and report age', async () => {
  const {subs}=fakeStripe();
  env.SCOUT_PUBLISH_KEY='test-scout-key';
  await call('POST','/api/scout/research',{markets:[researchMarket()]},{Authorization:'Bearer test-scout-key'});
  const c=await call('POST','/api/pro/claim',{session_id:'cs_test_paidsession123'});
  const auth={Authorization:'Bearer '+c.body.token};
  assert.equal((await call('GET','/api/pro/scout',null,auth)).body.report.candidates.length,1);
  games['nfl|2026-11-08'][0].state='in';
  assert.equal((await call('GET','/api/pro/scout',null,auth)).body.report.candidates.length,0);
  games['nfl|2026-11-08'][0].state='pre';clock+=31*60000;
  const old=await call('GET','/api/pro/scout',null,auth);
  assert.equal(old.body.expired,true);assert.equal(old.body.report.candidates.length,0);
  subs.cus_A=[{status:'canceled'}];
  assert.equal((await call('GET','/api/pro/scout',null,auth)).status,403);
});
