// Birdman Picks server (Cloudflare Worker). Routes for the verified record, free pick'em pools and Pro,
// plus a job every 5 minutes that grades picks and records closing lines.
import { fetchScoreboard } from '../src/espn';
import { captureCloses, gradePending } from '../src/grader';
import { getRecord, isAdmin, postPick, settleRecord } from './record';
import { createPool, getPool, joinPool, savePoolPick, settlePools } from './pickem';
import * as pro from './pro';
import { getResearch, publishResearch, scoutEnabled } from './scout';
import { HttpError, json, type Deps, type Env } from './util';

export const liveDeps: Deps = {
  now: () => Date.now(),
  games: (league, date) => fetchScoreboard(league, date),
  grade: gradePending,
  closes: captureCloses,
};

function cors(origin: string, env: Env): Record<string, string> | null {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Pool-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function route(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (m === 'GET' && (path === '/' || path === '/api/health')) return json({ ok: true });
  if (m === 'GET' && path === '/api/record') return getRecord(env);
  if (m === 'POST' && path === '/api/record/picks') return postPick(request, env, deps);
  if (m === 'GET' && path === '/api/record/owner') {
    if (!isAdmin(request, env)) throw new HttpError(401, "That owner key doesn't match.");
    return json({ owner: true });
  }

  if (m === 'POST' && path === '/api/pools') return createPool(request, env, deps);
  if (m === 'POST' && path === '/api/pools/join') return joinPool(request, env, deps);
  const pool = path.match(/^\/api\/pools\/([A-Z0-9]{4,12})(\/picks)?$/);
  if (pool && m === 'GET' && !pool[2]) return getPool(request, env, deps, pool[1]);
  if (pool && m === 'PUT' && pool[2]) return savePoolPick(request, env, deps, pool[1]);

  if (m === 'GET' && path === '/api/scout/enabled') return scoutEnabled(env);
  if (m === 'GET' && path === '/api/pro/scout') return getResearch(request, env, deps);
  if (m === 'POST' && path === '/api/scout/research') return publishResearch(request, env, deps);

  if (m === 'POST' && path === '/api/pro/claim') return pro.claim(request, env);
  if (m === 'GET' && path === '/api/pro/status') return pro.status(request, env);
  if (m === 'POST' && path === '/api/pro/portal') return pro.portal(request, env);
  if (m === 'POST' && path === '/api/pro/restore/start') return pro.restoreStart(request, env, deps);
  if (m === 'POST' && path === '/api/pro/restore/verify') return pro.restoreVerify(request, env, deps);

  throw new HttpError(404, 'Not found.');
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const origin = request.headers.get('Origin') || '';
  const c = cors(origin, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: c ? 204 : 403, headers: c ?? {} });
  // Browsers must come from the app; tools without an Origin (curl, the owner's scripts) are fine.
  if (origin && !c) return json({ error: 'Not allowed.' }, 403);

  let res: Response;
  try {
    if (!env.DB) throw new HttpError(503, "The server's database isn't connected yet.");
    res = await route(request, env, deps);
  } catch (e) {
    if (e instanceof HttpError) res = json({ error: e.message }, e.status);
    else {
      console.error(e instanceof Error ? e.stack : String(e));
      res = json({ error: 'Something went wrong. Try again in a minute.' }, 500);
    }
  }
  if (c) for (const [k, v] of Object.entries(c)) res.headers.set(k, v);
  return res;
}

export async function settleAll(env: Env, deps: Deps) {
  const [record, pools] = await Promise.all([settleRecord(env, deps), settlePools(env, deps)]);
  return { record, pools };
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env, liveDeps),
  scheduled: (_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => {
    ctx.waitUntil(settleAll(env, liveDeps).then((r) => console.log('settled', JSON.stringify(r))));
  },
};

// For tests and anyone checking the record by hand.
export { GENESIS, lockedFields, pickHash } from '../src/recordhash';

export { research, breakEven, refreshResearch } from './scout';
