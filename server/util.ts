// Shared plumbing for the Birdman Picks server: settings, responses, hashing.
import type { Game, LeagueKey } from '../src/espn';
import type { Bet } from '../src/bets';

/** Minimal slice of Cloudflare D1 that the server uses. */
export interface D1Result<T> {
  results: T[];
  meta?: { changes?: number; last_row_id?: number };
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
export interface D1 {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<D1Result<unknown>[]>;
}

export interface Env {
  DB: D1;
  ALLOWED_ORIGIN?: string;
  APP_URL?: string;
  /** Lets the owner post picks to the public record. */
  ADMIN_KEY?: string;
  /** Lets the pick agent post picks; they're marked as the model's. */
  AGENT_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  TOKEN_SECRET?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
}

/** Outside data the server reads. Swapped for fakes in tests. */
export interface Deps {
  now(): number;
  games(league: LeagueKey, date: string): Promise<Game[]>;
  grade(bets: Bet[]): Promise<Map<string, Partial<Bet>>>;
  closes(bets: Bet[]): Promise<Map<string, Partial<Bet>>>;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 8192) throw new HttpError(413, 'Too much data.');
  try {
    const data = JSON.parse(text || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    throw new HttpError(400, "That request wasn't readable.");
  }
}

export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function bearer(request: Request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

export async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export const randomToken = (bytes = 24) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Today's date in US Eastern time, YYYY-MM-DD, which is how ESPN dates its slates. */
export function easternDate(ms: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Monday of the week containing `ymd`. */
export function weekStart(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const back = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

export const isYMD = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
