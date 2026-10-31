// Records carried over from the original Birdman Picks site so nothing is lost on first launch.
import type { Bet } from './bets';
import type { Lineup, Slot } from './fantasy';

const s = (slot: string, player: string, team: string, salary: number, points: number | null = null): Slot => ({
  slot,
  player,
  team,
  salary,
  points,
});

export const SEED_LINEUPS: Lineup[] = [
  {
    id: 'seed-1027',
    title: 'October 27 FanDuel entry',
    date: '2026-10-27',
    templateId: 'fd-nba',
    cap: 60000,
    winnings: 0,
    notes:
      'Final 261.9. First five produced 234.5; last four 27.4 on $16,400 (1.67 pts/$1K). Lesson: require a sourced minutes/role check for every salary-saver and flag zero-minute risk.',
    slots: [
      s('PG', 'Luka Dončić', 'POR @ LAL', 11600, 61.5),
      s('SG', 'Austin Reaves', 'POR @ LAL', 8100, 41.3),
      s('SF', 'Paul George', 'BKN @ BOS', 7300, 41.9),
      s('PF', 'Deni Avdija', 'POR @ LAL', 8100, 41.3),
      s('C', 'Karl-Anthony Towns', 'DET @ NY', 8300, 48.5),
      s('G/F', 'Collin Sexton', 'POR @ LAL', 4000, 13.2),
      s('F/C', 'Taurean Prince', 'DET @ NY', 3500, 9),
      s('UTIL', 'B. Carlson', 'POR @ LAL', 3500, 0),
      s('UTIL', 'Precious Achiuwa', 'SAC @ SA', 5400, 5.2),
    ],
  },
  {
    id: 'seed-1026a',
    title: 'October 26 lineup',
    date: '2026-10-26',
    templateId: 'fd-nba-classic',
    cap: 60000,
    notes:
      'Haliburton/Jaquez target IND–MIL total 240.5. Pre-lock alternative: Huff → Rudy Gobert ($5,500), Naz Reid → Kyle Filipowski ($3,700).',
    slots: [
      s('PG', 'Tyrese Haliburton', 'IND @ MIL', 8200),
      s('PG', 'Derrick White', 'BOS vs CHI', 5900),
      s('SG', 'Donovan Mitchell', 'CLE vs MIN', 8600),
      s('SG', 'Grayson Allen', 'CHA vs WAS', 5200),
      s('SF', 'Jayson Tatum', 'BOS vs CHI', 9900),
      s('SF', 'Jaime Jaquez Jr.', 'MIL vs IND', 5900),
      s('PF', 'Naz Reid', 'CHA vs WAS', 7000),
      s('PF', 'P.J. Washington', 'DAL @ MIA', 5600),
      s('C', 'Jay Huff', 'IND @ MIL', 3600),
    ],
  },
  {
    id: 'seed-1026b',
    title: '$2K Monday Dribbler entry',
    date: '2026-10-26',
    templateId: 'fd-nba',
    cap: 60000,
    notes: 'Contest starts 7:00 PM EDT. C. Boozer full name/matchup obscured in screenshot.',
    slots: [
      s('PG', 'Tyrese Haliburton', 'IND @ MIL', 8200),
      s('SG', 'Grayson Allen', 'WAS @ CHA', 5200),
      s('SF', 'Jayson Tatum', 'CHI @ BOS', 9900),
      s('PF', 'Naz Reid', 'WAS @ CHA', 7000),
      s('C', 'Jay Huff', 'IND @ MIL', 3600),
      s('G/F', 'Derrick White', 'CHI @ BOS', 5900),
      s('F/C', 'P.J. Washington', 'DAL @ MIA', 5600),
      s('UTIL', 'Paul George', 'CHI @ BOS', 7400),
      s('UTIL', 'C. Boozer', '', 7200),
    ],
  },
  {
    id: 'seed-1022a',
    title: 'Shai and Cleveland',
    date: '2026-10-22',
    templateId: 'fd-nba-classic',
    cap: 60000,
    notes: 'Four CLE and four OKC players concentrate the risk.',
    slots: [
      s('PG', 'Shai Gilgeous-Alexander', 'OKC', 10200),
      s('PG', 'James Harden', 'CLE', 8000),
      s('SG', 'Donovan Mitchell', 'CLE', 8200),
      s('SG', 'Cason Wallace', 'OKC', 4200),
      s('SF', 'Peyton Watson', 'CLE', 5300),
      s('SF', 'Cameron Johnson', 'DEN', 4600),
      s('PF', 'Evan Mobley', 'CLE', 7600),
      s('PF', 'Chet Holmgren', 'OKC', 7000),
      s('C', 'Isaiah Hartenstein', 'OKC', 4700),
    ],
  },
  {
    id: 'seed-1022b',
    title: 'Jokic build',
    date: '2026-10-22',
    templateId: 'fd-nba-classic',
    cap: 60000,
    notes: "Ajay Mitchell's minutes are the key uncertainty.",
    slots: [
      s('PG', 'Jamal Murray', 'DEN', 8400),
      s('PG', 'Ajay Mitchell', 'OKC', 4400),
      s('SG', 'Christian Braun', 'DEN', 4800),
      s('SG', 'Cason Wallace', 'OKC', 4200),
      s('SF', 'Jalen Williams', 'OKC', 6800),
      s('SF', 'Cameron Johnson', 'DEN', 4600),
      s('PF', 'Evan Mobley', 'CLE', 7600),
      s('PF', 'Chet Holmgren', 'OKC', 7000),
      s('C', 'Nikola Jokic', 'DEN', 12200),
    ],
  },
];

export const SEED_BETS: Bet[] = [
  {
    id: 'seed-parlay-1027',
    createdAt: '2026-10-27T23:00:00.000Z',
    date: '2026-10-27',
    selection: '8-leg Same Game Parlay+',
    market: 'parlay',
    odds: 16274,
    stake: 1,
    book: 'FanDuel',
    status: 'pending',
    notes: [
      'SAC @ SA: Over 231.5 (alt) · SAC +17.5 (alt) · Darius Acuff Jr. Under 2.5 threes',
      'DET @ NYK: NYK -3.5 (alt)',
      'POR @ LAL: Under 234.5 · Damian Lillard Under 3.5 threes',
      'BKN @ BOS: BKN +11.5',
      'PHI @ IND (10/28): Over 238.5',
    ].join('\n'),
  },
];
