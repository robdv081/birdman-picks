// Birdman Picks Pro: confirms Stripe Payment Link purchases, hands the app a signed token, checks the
// subscription is still active, restores Pro on a new device by emailed code, and opens Stripe's billing page.
import { b64url, bearer, fromB64url, HttpError, json, readJson, sha256, str, timingSafeEqual, type Deps, type Env } from './util';

const STRIPE = 'https://api.stripe.com/v1';
const GOOD = new Set(['active', 'trialing']);
const CODE_TTL_MS = 10 * 60_000;
const RESEND_GAP_MS = 60_000;
const MAX_TRIES = 5;

function needStripe(env: Env) {
  if (!env.STRIPE_SECRET_KEY || !env.TOKEN_SECRET) throw new HttpError(503, "Pro isn't set up on the server yet.");
}

/** POST /api/pro/claim {session_id} — after checkout, Stripe sends the buyer back with ?session_id=cs_... */
export async function claim(request: Request, env: Env) {
  needStripe(env);
  const sessionId = str((await readJson(request)).session_id, 220);
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) throw new HttpError(400, "That checkout link isn't valid.");
  const s = await stripeGet(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!s) throw new HttpError(404, 'Checkout not found.');
  const paid = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  if (!paid || typeof s.customer !== 'string') throw new HttpError(402, "That checkout isn't finished yet.");
  const pro = await customerIsPro(env, s.customer);
  if (!pro.active) throw new HttpError(402, 'No active Pro subscription on that checkout.');
  return json({ token: await makeToken(env, s.customer), pro: true, renews: pro.renews });
}

/** GET /api/pro/status (Bearer token) */
export async function status(request: Request, env: Env) {
  needStripe(env);
  const customer = await customerFromToken(env, bearer(request));
  if (!customer) return json({ pro: false, reason: 'signed_out' }, 401);
  const pro = await customerIsPro(env, customer);
  return json({ pro: pro.active, renews: pro.renews, cancelsAtPeriodEnd: pro.cancelsAtPeriodEnd });
}

/** POST /api/pro/portal (Bearer token) */
export async function portal(request: Request, env: Env) {
  needStripe(env);
  const customer = await customerFromToken(env, bearer(request));
  if (!customer) throw new HttpError(401, 'Sign in to Pro first.');
  const s = await stripePost(env, '/billing_portal/sessions', { customer, return_url: env.APP_URL || 'https://robdv081.github.io/birdman-picks/' });
  return json({ url: s.url });
}

/** POST /api/pro/restore/start {email} — same answer whether or not the email has Pro. */
export async function restoreStart(request: Request, env: Env, deps: Deps) {
  needStripe(env);
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) throw new HttpError(501, "Restore by email isn't set up yet.");
  const email = normalizeEmail((await readJson(request)).email);
  if (!email) throw new HttpError(400, 'Enter a valid email.');
  const reply = json({ sent: true, message: 'If that email has Pro, a code is on its way.' });

  const now = deps.now();
  const emailHash = await sha256(email);
  const prev = await env.DB.prepare('SELECT sent_at FROM restore_codes WHERE email_hash = ?').bind(emailHash).first<{ sent_at: number }>();
  if (prev && now - prev.sent_at < RESEND_GAP_MS) return reply;

  const customer = await findProCustomerByEmail(env, email);
  if (!customer) return reply;
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  await env.DB.prepare(
    `INSERT INTO restore_codes (email_hash, code_hash, customer, tries, expires_at, sent_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT (email_hash) DO UPDATE SET code_hash = excluded.code_hash, customer = excluded.customer, tries = 0, expires_at = excluded.expires_at, sent_at = excluded.sent_at`
  )
    .bind(emailHash, await sha256(`${email}:${code}`), customer, now + CODE_TTL_MS, now)
    .run();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [email],
      subject: `Your Birdman Picks code: ${code}`,
      text: `Your Birdman Picks Pro code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
    }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status}`);
  return reply;
}

/** POST /api/pro/restore/verify {email, code} */
export async function restoreVerify(request: Request, env: Env, deps: Deps) {
  needStripe(env);
  const b = await readJson(request);
  const email = normalizeEmail(b.email);
  const code = str(b.code, 12).replace(/\D/g, '');
  if (!email || code.length !== 6) throw new HttpError(400, 'Enter the 6-digit code.');
  const emailHash = await sha256(email);
  const rec = await env.DB.prepare('SELECT * FROM restore_codes WHERE email_hash = ?').bind(emailHash).first<{
    code_hash: string;
    customer: string;
    tries: number;
    expires_at: number;
  }>();
  if (!rec || rec.expires_at < deps.now() || rec.tries >= MAX_TRIES) throw new HttpError(400, 'That code expired. Request a new one.');
  if (!timingSafeEqual(rec.code_hash, await sha256(`${email}:${code}`))) {
    await env.DB.prepare('UPDATE restore_codes SET tries = tries + 1 WHERE email_hash = ?').bind(emailHash).run();
    throw new HttpError(400, 'Wrong code.');
  }
  await env.DB.prepare('DELETE FROM restore_codes WHERE email_hash = ?').bind(emailHash).run();
  const pro = await customerIsPro(env, rec.customer);
  if (!pro.active) throw new HttpError(402, "That Pro subscription isn't active.");
  return json({ token: await makeToken(env, rec.customer), pro: true, renews: pro.renews });
}

// ---------- Stripe ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function customerIsPro(env: Env, customer: string) {
  const subs = await stripeGet(env, `/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`);
  const good = (subs?.data ?? []).find((s: Json) => GOOD.has(s.status));
  if (!good) return { active: false, renews: null as string | null, cancelsAtPeriodEnd: false };
  const end = good.current_period_end ?? good.items?.data?.[0]?.current_period_end ?? null;
  return { active: true, renews: end ? new Date(end * 1000).toISOString() : null, cancelsAtPeriodEnd: !!good.cancel_at_period_end };
}

async function findProCustomerByEmail(env: Env, email: string) {
  const res = await stripeGet(env, `/customers?email=${encodeURIComponent(email)}&limit=10`);
  for (const c of res?.data ?? []) if ((await customerIsPro(env, c.id)).active) return c.id as string;
  return null;
}

async function stripeGet(env: Env, path: string): Promise<Json> {
  const res = await fetch(STRIPE + path, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  if (res.status === 404) return null;
  const data = (await res.json()) as Json;
  if (!res.ok) throw new Error(`Stripe GET ${path.split('?')[0]} -> ${res.status}: ${data?.error?.message}`);
  return data;
}

async function stripePost(env: Env, path: string, params: Record<string, string>): Promise<Json> {
  const res = await fetch(STRIPE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as Json;
  if (!res.ok) throw new Error(`Stripe POST ${path} -> ${res.status}: ${data?.error?.message}`);
  return data;
}

// ---------- tokens ----------

async function sign(env: Env, payload: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TOKEN_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

async function makeToken(env: Env, customer: string) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ c: customer, v: 1 })));
  return `${payload}.${await sign(env, payload)}`;
}

async function customerFromToken(env: Env, token: string) {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  if (!timingSafeEqual(sig, await sign(env, payload))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof data.c === 'string' && data.c.startsWith('cus_') ? (data.c as string) : null;
  } catch {
    return null;
  }
}

function normalizeEmail(v: unknown) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Server-side gate: browser cached membership never authorizes research access. */
export async function requirePro(request: Request, env: Env) {
  needStripe(env);
  const customer = await customerFromToken(env, bearer(request));
  if (!customer) throw new HttpError(401, 'Sign in to Pro first.');
  const pro = await customerIsPro(env, customer);
  if (!pro.active) throw new HttpError(403, 'An active Pro subscription is required.');
  return { customer, renews: pro.renews };
}
