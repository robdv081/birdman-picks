/** One spelling per player, so "De'Anthony Melton Jr." on a bet matches "DeAnthony Melton" on an injury report. */
export function playerKey(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Statuses worth waking someone up for. */
export const ALERT_STATUSES = ['out', 'doubtful', 'questionable', 'day-to-day', 'injured reserve', 'suspension'];
export const isAlertStatus = (s: string) => ALERT_STATUSES.some((x) => s.toLowerCase().includes(x));
