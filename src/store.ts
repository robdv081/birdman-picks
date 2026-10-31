import { useEffect, useState } from 'react';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked; keep working in memory */
  }
}

/** useState that persists to localStorage. */
export function useStored<T>(key: string, fallback: () => T) {
  const [value, setValue] = useState<T>(() => load(key, fallback()));
  useEffect(() => save(key, value), [key, value]);
  return [value, setValue] as const;
}

export function todayYMD(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftYMD(ymd: string, days: number) {
  const [y, m, d] = ymd.split('-').map(Number);
  return todayYMD(new Date(y, m - 1, d + days));
}

export function fmtDate(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
