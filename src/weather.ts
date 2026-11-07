// Kickoff weather for outdoor football games from Open-Meteo (free, no key). ESPN gives the venue and a
// forecast summary but not wind, which is what moves passing and kicking.
import type { Game } from './espn';
import { load, save } from './store';

export interface GameWeather {
  windMph: number;
  gustMph: number;
  rainChance: number; // %
  tempF: number;
}

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

type LatLon = { lat: number; lon: number };

// Stadium locations never change, so remember them on this device: each city is looked up once, ever.
const GEO_KEY = 'bp.geo';
const geoCache: Record<string, LatLon | null> = load(GEO_KEY, {});
const geoInflight = new Map<string, Promise<LatLon | null>>();
let geoChain: Promise<unknown> = Promise.resolve();

/** Coordinates for a US city. Lookups run one at a time so a busy Saturday doesn't trip Open-Meteo's rate limit. */
function locate(city: string, state?: string): Promise<LatLon | null> {
  const key = `${city}|${state ?? ''}`;
  if (key in geoCache) return Promise.resolve(geoCache[key]);
  if (!geoInflight.has(key)) {
    const job = geoChain.then(async () => {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&countryCode=US`);
      if (!r.ok) throw new Error(`geocoding ${r.status}`);
      const j = await r.json();
      const want = state ? STATES[state.toUpperCase()] ?? state : undefined;
      const hit = (j.results ?? []).find((x: { admin1?: string }) => !want || x.admin1 === want) ?? j.results?.[0];
      const at = hit ? { lat: hit.latitude, lon: hit.longitude } : null;
      geoCache[key] = at;
      save(GEO_KEY, geoCache);
      return at;
    });
    geoChain = job.catch(() => undefined);
    // A failed lookup (rate limit, offline) isn't remembered, so it's tried again next time.
    geoInflight.set(key, job.catch(() => (geoInflight.delete(key), null)));
  }
  return geoInflight.get(key)!;
}

const forecasts = new Map<string, Promise<GameWeather | null>>();
let queue: { g: Game; resolve: (w: GameWeather | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function atKickoff(j: { hourly?: Record<string, (number | string)[]> }, g: Game): GameWeather | null {
  const h = j.hourly;
  const times = (h?.time ?? []) as string[];
  const kickoff = new Date(g.start).toISOString().slice(0, 13); // "2026-11-08T18"
  const i = times.findIndex((t) => t.startsWith(kickoff));
  if (!h || i < 0) return null;
  const n = (k: string) => Math.round(Number(h[k]?.[i] ?? 0));
  return { windMph: n('wind_speed_10m'), gustMph: n('wind_gusts_10m'), rainChance: n('precipitation_probability'), tempF: n('temperature_2m') };
}

/** Sends every forecast asked for in the last moment as one Open-Meteo request (it takes many coordinates at once). */
async function flush() {
  const batch = queue;
  queue = [];
  timer = null;
  const located = await Promise.all(batch.map(async (b) => ({ ...b, at: await locate(b.g.venueCity!, b.g.venueState) })));
  for (const x of located) if (!x.at) x.resolve(null);
  const ok = located.filter((x) => x.at);
  for (let i = 0; i < ok.length; i += 50) {
    const chunk = ok.slice(i, i + 50);
    try {
      const r = await fetch(
        'https://api.open-meteo.com/v1/forecast' +
          `?latitude=${chunk.map((c) => c.at!.lat.toFixed(3)).join(',')}&longitude=${chunk.map((c) => c.at!.lon.toFixed(3)).join(',')}` +
          '&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m' +
          '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&forecast_days=7'
      );
      if (!r.ok) throw new Error(`forecast ${r.status}`);
      const j = await r.json();
      const list = Array.isArray(j) ? j : [j]; // one location comes back as an object, several as a list
      chunk.forEach((c, k) => c.resolve(atKickoff(list[k] ?? {}, c.g)));
    } catch {
      // Forget the failure so a later look tries again.
      chunk.forEach((c) => {
        forecasts.delete(c.g.id);
        c.resolve(null);
      });
    }
  }
}

/** Forecast at kickoff for an outdoor NFL or college football game; null indoors, abroad, or past the forecast window. */
export function gameWeather(g: Game): Promise<GameWeather | null> {
  if ((g.league !== 'nfl' && g.league !== 'cfb') || g.indoor !== false || !g.venueCity || g.completed) return Promise.resolve(null);
  if (!forecasts.has(g.id)) {
    forecasts.set(
      g.id,
      new Promise((resolve) => {
        queue.push({ g, resolve });
        timer ??= setTimeout(flush, 60);
      })
    );
  }
  return forecasts.get(g.id)!;
}

/** Passing and kicking suffer in wind; heavy rain trims a little more. Returns a multiplier for pass-game players. */
export function passGameFactor(w: GameWeather | null): number {
  if (!w) return 1;
  let f = 1;
  // Gusts only matter on top of a real steady wind; a lone gust in a calm forecast is noise.
  const gusty = w.windMph >= 10;
  if (w.windMph >= 20 || (gusty && w.gustMph >= 35)) f -= 0.12;
  else if (w.windMph >= 15 || (gusty && w.gustMph >= 28)) f -= 0.06;
  if (w.rainChance >= 70) f -= 0.04;
  return f;
}

export function weatherNote(w: GameWeather | null): string | null {
  if (!w) return null;
  const parts = [`${w.tempF}°`, `wind ${w.windMph} mph${w.gustMph >= w.windMph + 8 ? `, gusts ${w.gustMph}` : ''}`];
  if (w.rainChance >= 40) parts.push(`${w.rainChance}% rain`);
  return parts.join(' · ');
}
