// Kickoff weather for outdoor football games from Open-Meteo (free, no key). ESPN gives the venue and a
// forecast summary but not wind, which is what moves passing and kicking.
import type { Game } from './espn';

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

const coords = new Map<string, Promise<{ lat: number; lon: number } | null>>();
const forecasts = new Map<string, Promise<GameWeather | null>>();

function locate(city: string, state?: string) {
  const key = `${city}|${state ?? ''}`;
  if (!coords.has(key)) {
    coords.set(
      key,
      fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&countryCode=US`)
        .then((r) => r.json())
        .then((j) => {
          const want = state ? STATES[state.toUpperCase()] ?? state : undefined;
          const hit = (j.results ?? []).find((x: { admin1?: string }) => !want || x.admin1 === want) ?? j.results?.[0];
          return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
        })
        .catch(() => null)
    );
  }
  return coords.get(key)!;
}

/** Forecast at kickoff for an outdoor NFL or college football game; null indoors, abroad, or past the forecast window. */
export function gameWeather(g: Game): Promise<GameWeather | null> {
  if ((g.league !== 'nfl' && g.league !== 'cfb') || g.indoor !== false || !g.venueCity || g.completed) return Promise.resolve(null);
  if (!forecasts.has(g.id)) {
    forecasts.set(
      g.id,
      (async () => {
        const at = await locate(g.venueCity!, g.venueState);
        if (!at) return null;
        const j = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${at.lat}&longitude=${at.lon}` +
            '&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m' +
            '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&forecast_days=7'
        ).then((r) => r.json());
        const times: string[] = j.hourly?.time ?? [];
        const kickoff = new Date(g.start).toISOString().slice(0, 13); // "2026-11-08T18"
        const i = times.findIndex((t) => t.startsWith(kickoff));
        if (i < 0) return null;
        return {
          windMph: Math.round(j.hourly.wind_speed_10m[i]),
          gustMph: Math.round(j.hourly.wind_gusts_10m[i]),
          rainChance: Math.round(j.hourly.precipitation_probability[i] ?? 0),
          tempF: Math.round(j.hourly.temperature_2m[i]),
        };
      })().catch(() => null)
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
