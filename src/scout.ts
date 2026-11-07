// Shared contract. Evidence is supplied by an authenticated research publisher, never by a subscriber.
export interface Evidence {
  url: string;
  checkedAt: string;
  kind: 'official' | 'bookmaker';
  note: string;
}
export interface ResearchMarket {
  league: 'nfl' | 'cfb' | 'nba' | 'nhl' | 'mlb';
  eventId: string;
  start: string;
  market: string;
  odds: number;
  bookmaker: string;
  evidence: Evidence[];
  availabilityConfirmed: boolean;
  counterarguments: string;
  passIf: string;
  // Optional independent estimate. Never manufacture one from bookmaker odds or hit rates.
  estimate?: { probability: number; method: string; validation: string; source: string };
}
export interface ScoutCandidate extends ResearchMarket {
  event: string;
  breakEven: number;
  edge: number;
  units: 1;
}
export interface ScoutReport {
  id: string;
  checkedAt: string;
  date: string;
  agents: { scout: string; analyst: string };
  feeds: { league: string; checkedAt: string; stale: boolean; events: number }[];
  candidates: ScoutCandidate[];
  passes: { eventId: string; reason: string }[];
  status: 'paper_candidates' | 'no_verified_picks';
}
