// Fetches DraftKings' classic-contest player lists (salaries, positions, injury status) for NFL, NBA and NHL
// and writes them to public/data/dk-slates.json, which the site serves next to the app. DraftKings doesn't
// allow these files to be read from a browser, so the deploy workflow runs this on a schedule instead.
// Uses the same public CSV a player downloads from a contest page.
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/data/dk-slates.json', import.meta.url);
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; birdman-picks salary sync; +https://github.com/robdv081/birdman-picks)' };
const LOOKAHEAD_HOURS = 48;
const MAX_SLATES_PER_SPORT = 4;

// DraftKings game type ids for classic salary-cap contests.
const SPORTS = {
  NFL: { gameType: 1, sport: 'nfl', slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'] },
  NBA: { gameType: 70, sport: 'nba', slots: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'] },
  NHL: { gameType: 125, sport: 'nhl', slots: ['C', 'C', 'W', 'W', 'W', 'D', 'D', 'G', 'UTIL'] },
};

function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parsePlayers(csv) {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const h = splitCsv(lines[0]);
  const col = (name) => h.indexOf(name);
  const [iPos, iName, iId, iRoster, iSal, iGame, iTeam, iAvg, iStatus] = [
    'Position', 'Name', 'ID', 'Roster Position', 'Salary', 'Game Info', 'TeamAbbrev', 'AvgPointsPerGame', 'Status',
  ].map(col);
  return lines.slice(1).map((l) => {
    const c = splitCsv(l);
    // "MIN@DET 11/01/2026 01:00PM ET"
    const [matchup = '', date = '', time = ''] = (c[iGame] ?? '').split(' ');
    const [away, home] = matchup.split('@');
    const team = c[iTeam];
    return {
      id: c[iId],
      name: c[iName],
      pos: (c[iPos] ?? '').split('/'),
      slots: (c[iRoster] ?? '').split('/'),
      salary: Number(c[iSal]),
      team,
      opp: team === away ? home : away,
      game: matchup || undefined,
      time: date && time ? `${date} ${time} ET` : undefined,
      avg: Number(c[iAvg]) || 0,
      status: iStatus >= 0 ? c[iStatus] || '' : '',
    };
  });
}

async function slatesFor(key, cfg) {
  const lobby = await fetch(`https://www.draftkings.com/lobby/getcontests?sport=${key}`, { headers: HEADERS }).then((r) => {
    if (!r.ok) throw new Error(`lobby ${r.status}`);
    return r.json();
  });
  const now = Date.now();
  const groups = (lobby.DraftGroups ?? [])
    .filter((g) => g.GameTypeId === cfg.gameType)
    .filter((g) => {
      // StartDateEst is Eastern time without an offset; treat it as UTC-5 (close enough for a 48h window).
      const t = Date.parse(`${g.StartDateEst}-05:00`);
      return t > now - 6 * 3600_000 && t < now + LOOKAHEAD_HOURS * 3600_000;
    })
    .sort((a, b) => (b.DraftGroupTag === 'Featured') - (a.DraftGroupTag === 'Featured') || b.GameCount - a.GameCount)
    .slice(0, MAX_SLATES_PER_SPORT);

  const slates = [];
  for (const g of groups) {
    const res = await fetch(
      `https://www.draftkings.com/lineup/getavailableplayerscsv?contestTypeId=${g.GameTypeId}&draftGroupId=${g.DraftGroupId}`,
      { headers: HEADERS }
    );
    if (!res.ok) {
      console.warn(`${key} ${g.DraftGroupId}: ${res.status}`);
      continue;
    }
    const players = parsePlayers(await res.text()).filter((p) => p.id && p.salary > 0);
    slates.push({
      id: `dk-${g.DraftGroupId}`,
      site: 'dk',
      sport: cfg.sport,
      label: (g.ContestStartTimeSuffix ?? '').replace(/[()]/g, '').trim() || 'Main',
      start: g.StartDateEst,
      games: g.GameCount,
      cap: 50000,
      slots: cfg.slots,
      players,
    });
    console.log(`${key} ${g.DraftGroupId} ${slates.at(-1).label}: ${players.length} players`);
  }
  return slates;
}

const all = [];
for (const [key, cfg] of Object.entries(SPORTS)) {
  try {
    all.push(...(await slatesFor(key, cfg)));
  } catch (e) {
    console.warn(`${key}: ${e.message}`);
  }
}
mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), slates: all }));
console.log(`Wrote ${all.length} slates`);
