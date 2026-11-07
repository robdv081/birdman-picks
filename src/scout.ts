// Shared contract between the Scout publisher (scripts/scout.ts), the server (server/scout.ts) and the Scout page.
// Scout gathers today's schedules, injury reports and DraftKings prices from ESPN. Birdman Analyst turns the
// model's strongest edges into at most three paper picks, each with its sources, the price it needs, the reasons
// it could lose and when to pass. If the evidence isn't there, the answer is "No verified picks".

export const SCOUT_LEAGUES = ['nfl', 'cfb', 'nba', 'nhl', 'mcbb'] as const;
export type ScoutLeague = (typeof SCOUT_LEAGUES)[number];

export interface Evidence {
  url: string;
  checkedAt: string;
  kind: 'schedule' | 'injuries' | 'odds' | 'stats' | 'model';
  note: string;
}

export interface InjuryNote {
  team: string;
  player: string;
  status: string;
}

/** Scout's notes on one game: when it starts, the current price, how the line moved, and who is hurt. */
export interface GameResearch {
  league: ScoutLeague;
  eventId: string;
  start: string;
  matchup: string;
  url: string;
  odds?: string;
  moved?: string;
  injuries: InjuryNote[];
}

/** One Birdman Analyst paper pick. */
export interface AnalystPick {
  league: ScoutLeague;
  eventId: string;
  start: string;
  event: string;
  market: string;
  odds: number;
  bookmaker: string;
  /** Win rate needed to break even at this price, vig included. */
  breakEven: number;
  /** The model's chance the pick wins. */
  probability: number;
  edge: number;
  method: string;
  availability: string;
  evidence: Evidence[];
  counterarguments: string[];
  passIf: string[];
  /** Also posted to the public record by the pick agent. */
  onRecord: boolean;
}

export interface ScoutFeed {
  league: ScoutLeague;
  checkedAt: string;
  ok: boolean;
  events: number;
  injuries: boolean;
}

export interface ScoutReport {
  id: string;
  checkedAt: string;
  date: string;
  agents: { scout: string; analyst: string };
  feeds: ScoutFeed[];
  games: GameResearch[];
  candidates: AnalystPick[];
  passes: { event: string; reason: string }[];
  status: 'paper_candidates' | 'no_verified_picks';
}

/** What the publisher sends; the server stamps the id and date and re-checks every pick. */
export type ScoutSubmission = Omit<ScoutReport, 'id' | 'date' | 'status' | 'agents'>;

export const breakEven = (odds: number) => (odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100));

/** Hosts Scout may cite. Everything comes from ESPN's pages or DraftKings' own. */
export function citable(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    return ['espn.com', 'draftkings.com'].some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}
