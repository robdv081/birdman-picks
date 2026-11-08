// Pro phone alerts (Web Push): new Birdman picks, and line moves on picks a member follows. They arrive with the
// app closed. On iPhone the app has to be added to the Home Screen first; that's Apple's rule for web apps.
import { useEffect, useState } from 'react';
import { api, SERVER_URL, serverReady } from './server';
import { load, save } from './store';
import { proBearer } from './pro';

const STATE_KEY = 'bp.push';

export interface PushState {
  supported: boolean;
  on: boolean;
  picks: boolean;
  following: string[];
  busy?: boolean;
  error?: string;
}

const supported = () => serverReady() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let state: PushState = { supported: false, on: false, picks: true, following: [], ...load<Partial<PushState>>(STATE_KEY, {}) };
state.supported = typeof window !== 'undefined' && supported();
const listeners = new Set<(s: PushState) => void>();
function set(patch: Partial<PushState>) {
  state = { ...state, ...patch };
  save(STATE_KEY, { on: state.on, picks: state.picks, following: state.following });
  listeners.forEach((l) => l(state));
}

export function usePush() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

const proAuth = () => ({ Authorization: `Bearer ${proBearer()}` });

function keyBytes(b64: string) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function authOf(sub: PushSubscription) {
  const raw = sub.getKey('auth');
  if (!raw) throw new Error("This browser didn't provide a push key.");
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The service worker needs the server's address to collect messages; it can't read the app's settings. */
async function tellWorker() {
  const cache = await caches.open('birdman-config');
  await cache.put('/birdman-config', new Response(JSON.stringify({ server: SERVER_URL })));
}

async function register(sub: PushSubscription, picks: boolean) {
  await tellWorker();
  const r = await api<{ following: string[]; picks: boolean }>('/api/push/subscribe', {
    method: 'POST',
    body: { endpoint: sub.endpoint, auth: authOf(sub), picks },
    headers: proAuth(),
  });
  set({ on: true, picks: r.picks, following: r.following, error: undefined });
}

/** Turns alerts on (must run from a tap). */
export async function enablePush(picks = true) {
  set({ busy: true, error: undefined });
  try {
    if (!supported()) throw new Error('This browser can’t receive alerts.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser or phone settings.');
    const { key } = await api<{ key: string | null }>('/api/push/key');
    if (!key) throw new Error("Alerts aren't switched on yet on the server.");
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    await register(sub, picks);
  } catch (e) {
    set({ error: (e as Error).message });
  } finally {
    set({ busy: false });
  }
}

export async function disablePush() {
  set({ busy: true, error: undefined });
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint, auth: authOf(sub) } }).catch(() => {});
      await sub.unsubscribe();
    }
    set({ on: false, following: [] });
  } catch (e) {
    set({ error: (e as Error).message });
  } finally {
    set({ busy: false });
  }
}

export async function setPickAlerts(picks: boolean) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return set({ on: false });
  await register(sub, picks).catch((e) => set({ error: (e as Error).message }));
}

/** Follow line moves on a pending pick from the public record. */
export async function followPick(pickId: string, on: boolean) {
  set({ error: undefined });
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) throw new Error('Turn on Pro alerts first.');
    await api('/api/push/follow', { method: 'POST', body: { endpoint: sub.endpoint, auth: authOf(sub), pickId, on } });
    set({ following: on ? [...new Set([...state.following, pickId])] : state.following.filter((x) => x !== pickId) });
  } catch (e) {
    set({ error: (e as Error).message });
  }
}

/** On launch: if alerts are on, re-confirm with the server (it re-checks Pro and keeps the subscription alive). */
export async function refreshPush() {
  if (!state.on || !supported() || Notification.permission !== 'granted') {
    if (state.on && 'Notification' in window && Notification.permission !== 'granted') set({ on: false });
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return set({ on: false });
    await register(sub, state.picks);
  } catch (e) {
    const msg = (e as Error).message;
    // Pro lapsed: the server says so, and alerts stop.
    if (/Pro/.test(msg)) set({ on: false, following: [], error: msg });
  }
}
