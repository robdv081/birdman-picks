import type { LeagueKey } from './espn';

export interface Template {
  id: string;
  label: string;
  league: LeagueKey;
  cap: number;
  slots: string[];
}

export const TEMPLATES: Template[] = [
  { id: 'fd-nba', label: 'FanDuel NBA', league: 'nba', cap: 60000, slots: ['PG', 'SG', 'SF', 'PF', 'C', 'G/F', 'F/C', 'UTIL', 'UTIL'] },
  { id: 'fd-nba-classic', label: 'FanDuel NBA (classic)', league: 'nba', cap: 60000, slots: ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'] },
  { id: 'dk-nba', label: 'DraftKings NBA', league: 'nba', cap: 50000, slots: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'] },
  { id: 'fd-nfl', label: 'FanDuel NFL', league: 'nfl', cap: 60000, slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DEF'] },
  { id: 'dk-nfl', label: 'DraftKings NFL', league: 'nfl', cap: 50000, slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'] },
  { id: 'fd-cfb', label: 'FanDuel College Football', league: 'cfb', cap: 60000, slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'SUPERFLEX'] },
  { id: 'dk-cfb', label: 'DraftKings College Football', league: 'cfb', cap: 50000, slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'S-FLEX'] },
  { id: 'fd-nhl', label: 'FanDuel NHL', league: 'nhl', cap: 55000, slots: ['C', 'C', 'W', 'W', 'D', 'D', 'UTIL', 'UTIL', 'G'] },
  { id: 'dk-nhl', label: 'DraftKings NHL', league: 'nhl', cap: 50000, slots: ['C', 'C', 'W', 'W', 'W', 'D', 'D', 'G', 'UTIL'] },
];

export interface Slot {
  slot: string;
  player: string;
  team: string;
  salary: number | null;
  points: number | null;
}

export interface Lineup {
  id: string;
  title: string;
  date: string;
  templateId: string;
  cap: number;
  slots: Slot[];
  notes?: string;
  entryFee?: number | null;
  winnings?: number | null;
}

export const templateFor = (id: string) => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];

export function emptySlots(t: Template): Slot[] {
  return t.slots.map((slot) => ({ slot, player: '', team: '', salary: null, points: null }));
}

export function totals(l: Lineup) {
  const salary = l.slots.reduce((s, x) => s + (x.salary ?? 0), 0);
  const scored = l.slots.some((x) => x.points != null);
  const points = l.slots.reduce((s, x) => s + (x.points ?? 0), 0);
  return { salary, remaining: l.cap - salary, scored, points, perK: salary ? points / (salary / 1000) : 0 };
}
