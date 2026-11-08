// Birdman Picks Pro: checkout through a Stripe Payment Link, confirmed by the Birdman server.
// Stripe sends buyers back with ?session_id=..., the server checks it with Stripe and returns a signed
// token, and the app re-checks the subscription with the server on every launch.
import { useEffect, useState } from 'react';
import { api, ownerKey, serverReady } from './server';
import { load, save } from './store';

export const PAYMENT_LINK = 'https://buy.stripe.com/dRm4gzaQt4FP04E7BW1Jm00';

const TOKEN_KEY = 'bp.pro.token';
const CACHE_KEY = 'bp.pro.status';
// A recent "yes" is trusted for a while if the phone is offline, so a bad signal doesn't lock anyone out.
const OFFLINE_GRACE_MS = 24 * 3600_000;

export interface ProState {
  /** Pro features unlocked. */
  pro: boolean;
  /** False until the first check finishes, so screens don't flash the upgrade card. */
  checked: boolean;
  /** Pro switched on: needs the server. Until then every feature stays free. */
  enabled: boolean;
  renews?: string | null;
  cancelsAtPeriodEnd?: boolean;
  signedIn: boolean;
  /** Pro through the owner's key (free on the owner's own devices), not a subscription. */
  owner?: boolean;
  /** Set right after a purchase lands, for a thank-you note. */
  justBought?: boolean;
  error?: string;
}

const enabled = serverReady();
let state: ProState = (() => {
  const cached = load<{ pro?: boolean; renews?: string | null; at?: number }>(CACHE_KEY, {});
  const fresh = !!cached.at && Date.now() - cached.at < OFFLINE_GRACE_MS;
  return { pro: !enabled || (fresh && !!cached.pro), checked: !enabled, enabled, renews: cached.renews, signedIn: !!load<string>(TOKEN_KEY, '') };
})();
const listeners = new Set<(s: ProState) => void>();

function set(patch: Partial<ProState>) {
  state = { ...state, ...patch };
  if (enabled && patch.pro !== undefined) save(CACHE_KEY, { pro: state.pro, renews: state.renews, at: Date.now() });
  listeners.forEach((l) => l(state));
}

const token = () => load<string>(TOKEN_KEY, '');
const auth = () => ({ Authorization: `Bearer ${token()}` });
/** What Pro-only server calls send: the owner's key if signed in as owner, otherwise the Pro token. */
export const proBearer = () => ownerKey() || token();

/** After checkout: trade Stripe's session id for a Pro token. */
async function claimFromUrl() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session_id');
  if (!sessionId) return;
  params.delete('session_id');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + (location.hash || '#today'));
  try {
    const r = await api<{ token: string; renews: string | null }>('/api/pro/claim', { method: 'POST', body: { session_id: sessionId } });
    save(TOKEN_KEY, r.token);
    set({ pro: true, renews: r.renews, signedIn: true, justBought: true, error: undefined });
  } catch (e) {
    set({ error: `We couldn't confirm your purchase yet: ${(e as Error).message} If you were charged, use "Restore Pro" with your checkout email.` });
  }
}

export async function refreshPro() {
  if (!enabled) return;
  // Owner pass: the owner's key unlocks Pro on this device; the server checks the key.
  if (ownerKey()) {
    try {
      const r = await api<{ pro: boolean; owner?: boolean }>('/api/pro/status', { headers: { Authorization: `Bearer ${ownerKey()}` } });
      if (r.owner) return set({ pro: true, owner: true, renews: null, cancelsAtPeriodEnd: false, checked: true, signedIn: true });
    } catch (e) {
      if ((e as { status?: number }).status !== 401) return set({ checked: true }); // offline: keep what we had
    }
  }
  if (state.owner) set({ owner: false, pro: false });
  if (!token()) {
    set({ pro: false, checked: true, signedIn: false });
    return;
  }
  try {
    const r = await api<{ pro: boolean; renews: string | null; cancelsAtPeriodEnd?: boolean }>('/api/pro/status', { headers: auth() });
    set({ pro: r.pro, renews: r.renews, cancelsAtPeriodEnd: r.cancelsAtPeriodEnd, checked: true, signedIn: true });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) {
      save(TOKEN_KEY, '');
      set({ pro: false, checked: true, signedIn: false });
    } else set({ checked: true }); // offline or server hiccup: keep what we had
  }
}

let started = false;
/** Runs once when the app opens. */
export function startPro() {
  if (started || !enabled) return;
  started = true;
  claimFromUrl().finally(refreshPro);
  document.addEventListener('visibilitychange', () => !document.hidden && refreshPro());
}

export function usePro(): ProState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

/** Opens Stripe checkout. */
export function upgrade() {
  window.location.href = PAYMENT_LINK;
}

/** Opens Stripe's billing page to update the card or cancel. */
export async function manageBilling() {
  const r = await api<{ url: string }>('/api/pro/portal', { method: 'POST', body: {}, headers: auth() });
  window.location.href = r.url;
}

export async function restoreStart(email: string) {
  const r = await api<{ message: string }>('/api/pro/restore/start', { method: 'POST', body: { email } });
  return r.message;
}

export async function restoreVerify(email: string, code: string) {
  const r = await api<{ token: string; renews: string | null }>('/api/pro/restore/verify', { method: 'POST', body: { email, code } });
  save(TOKEN_KEY, r.token);
  set({ pro: true, renews: r.renews, signedIn: true, error: undefined });
}

export function dismissThanks() {
  set({ justBought: false, error: undefined });
}
