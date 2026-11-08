// Verified records for everyone, and the free weekly contest (see server/players.ts).
// This device's player sign-in is a token kept here; the "sign-in code" moves it to another device.
import { useEffect, useState } from 'react';
import { api, serverReady, type NewPick, type RecordPick } from './server';
import { load, save } from './store';
import { proBearer } from './pro';

const KEY = 'bp.player';

export interface Me {
  name: string;
  token: string;
}

export interface Week {
  week: string;
  picks: number;
  points: number;
  available: number;
  open: number;
}

export interface Profile {
  player: { name: string; since: number; branded: boolean };
  summary: { won: number; lost: number; push: number; pending: number; units: number; roi: number; clvMeasured: number; clvBeat: number };
  week: Week;
  picks: RecordPick[];
}

export interface Board {
  week: string;
  weekly: { name: string; picks: number; won: number; lost: number; points: number }[];
  allTime: { name: string; measured: number; beatPct: number; won: number; lost: number; roi: number }[];
  minClvPicks: number;
}

export const WEEK_POINTS = 1000;
export const STAKE_RANGE = [10, 500] as const;

let me: Me | null = load<Me | null>(KEY, null);
const listeners = new Set<(m: Me | null) => void>();
function setMe(m: Me | null) {
  me = m;
  save(KEY, m);
  listeners.forEach((l) => l(m));
}
export const currentPlayer = () => me;

export function useMe() {
  const [m, setM] = useState(me);
  useEffect(() => {
    listeners.add(setM);
    return () => void listeners.delete(setM);
  }, []);
  return m;
}

const auth = () => ({ 'X-Player-Token': me?.token ?? '' });

export async function createPlayer(name: string) {
  const r = await api<{ player: { name: string }; token: string }>('/api/players', { method: 'POST', body: { name: name.trim() } });
  setMe({ name: r.player.name, token: r.token });
}

/** Sign in on another device with the code from Compete → Sign-in code. */
export async function signInWithCode(code: string) {
  const token = code.trim();
  const r = await api<{ player: { name: string } }>('/api/players/me', { headers: { 'X-Player-Token': token } });
  setMe({ name: r.player.name, token });
}

export const signOut = () => setMe(null);

export const postPlayerPick = (p: Omit<NewPick, 'units'>, stake: number) =>
  api<{ pick: RecordPick; week: Week }>('/api/players/picks', { method: 'POST', body: { ...p, stake }, headers: auth() });

export const fetchProfile = (name: string) => api<Profile>(`/api/players/${encodeURIComponent(name)}`);
export const fetchBoard = () => api<Board>('/api/leaderboard');

/** Pro: the stream overlay without Birdman branding (renewed whenever the app opens while Pro). */
export const removeBranding = () =>
  api<{ branded: boolean }>('/api/players/brand', { method: 'POST', body: {}, headers: { ...auth(), Authorization: `Bearer ${proBearer()}` } });

export const playersReady = () => serverReady();

export const overlayUrl = (name: string) => `${location.origin}${location.pathname}#overlay/${encodeURIComponent(name)}`;
export const profileUrl = (name: string) => `${location.origin}${location.pathname}?s=profile#player/${encodeURIComponent(name)}`;
