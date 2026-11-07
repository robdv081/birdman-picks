// Sending picks to a sportsbook. Neither book lets another app place a bet, so this hands the pick over:
// DraftKings links put the exact outcome on its bet slip (ESPN's feed carries them for game lines);
// FanDuel has no such links, so the pick is copied and FanDuel opens on the right league.
import { fetchScoreboard, LEAGUES, type Game, type LeagueKey } from './espn';
import { fmtAmerican, propLabel, type Selection } from './bets';

export type Book = 'dk' | 'fd';
export const BOOK_LABEL: Record<Book, string> = { dk: 'DraftKings', fd: 'FanDuel' };

const DK_HOME = 'https://sportsbook.draftkings.com/';
const FD_HOME = 'https://sportsbook.fanduel.com/';

// FanDuel's league pages; anything else opens the sportsbook's home page.
const FD_PATH: Partial<Record<LeagueKey, string>> = {
  nfl: 'navigation/nfl',
  cfb: 'navigation/ncaaf',
  nba: 'navigation/nba',
  mcbb: 'navigation/ncaab',
  nhl: 'navigation/nhl',
  mlb: 'navigation/mlb',
};

export const fanduelUrl = (league?: LeagueKey) => FD_HOME + ((league && FD_PATH[league]) ?? '');

/** One line per pick, ready to paste into a note or search box. */
export function pickText(s: Selection): string {
  const what = s.market === 'prop' ? propLabel(s) : s.selection;
  const where = [s.league && LEAGUES[s.league].label, s.matchup].filter(Boolean).join(' · ');
  return `${what} (${fmtAmerican(s.odds)})${where ? ` — ${where}` : ''}`;
}

export function slipText(sels: Selection[], title?: string): string {
  return [title, ...sels.map((s, i) => (sels.length > 1 ? `${i + 1}. ${pickText(s)}` : pickText(s)))].filter(Boolean).join('\n');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export interface DkTarget {
  url: string;
  /** true: the link adds this outcome to the slip; false: it only opens the game, so find the pick there. */
  exact: boolean;
}

const boards = new Map<string, Promise<Game[]>>();
function board(league: LeagueKey, date: string) {
  const k = `${league}|${date}`;
  if (!boards.has(k)) {
    const p = fetchScoreboard(league, date).catch(() => [] as Game[]);
    boards.set(k, p);
    setTimeout(() => boards.delete(k), 5 * 60_000);
  }
  return boards.get(k)!;
}

/** Find the DraftKings link for a pick: its own outcome when the line still matches, else the game page. */
export async function dkTarget(s: Selection): Promise<DkTarget> {
  if (s.dkLink) return { url: s.dkLink, exact: true };
  if (!s.league || !s.eventId) return { url: DK_HOME, exact: false };
  const g = (await board(s.league, s.date)).find((x) => x.id === s.eventId);
  const o = g?.odds;
  const L = o?.links;
  if (!o || !L) return { url: DK_HOME, exact: false };
  const page = { url: L.event ?? DK_HOME, exact: false };
  const same = (a?: number, b?: number) => a != null && b != null && Math.abs(a - b) < 0.01;
  let url: string | undefined;
  if (s.market === 'ml') url = s.side === 'home' ? L.homeML : s.side === 'away' ? L.awayML : s.side === 'draw' ? L.draw : undefined;
  else if (s.market === 'spread')
    url = s.side === 'home' ? (same(o.homeSpread?.line, s.line) ? L.homeSpread : undefined) : same(o.awaySpread?.line, s.line) ? L.awaySpread : undefined;
  else if (s.market === 'total') url = same(o.over?.line, s.line) ? (s.side === 'over' ? L.over : L.under) : undefined;
  return url ? { url, exact: true } : page;
}

export function openUrl(url: string) {
  // A new tab keeps the app where it was; on a phone the link opens the sportsbook app when it's installed.
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.href = url;
}
