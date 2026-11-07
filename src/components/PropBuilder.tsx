import { useEffect, useMemo, useState } from 'react';
import { fetchScoreboard, LEAGUE_KEYS, LEAGUES, type Game, type LeagueKey } from '../espn';
import { breakEven, fmtAmerican, fmtPct, kellyUnits, type Leg } from '../bets';
import {
  buildParlay,
  candidateLabel,
  MODES,
  PROP_LEAGUES,
  scanProps,
  swapLeg,
  toLeg,
  type Candidate,
  type Mode,
  type Parlay,
} from '../propgen';
import { LINE_LEAGUES, scanGameLines } from '../gamelines';
import { fmtDate, shiftYMD, todayYMD } from '../store';

// Player props where the book posts them; game lines (moneyline, spread) for college football, which has none.
const BUILDER_LEAGUES = LEAGUE_KEYS.filter((k) => PROP_LEAGUES.includes(k) || LINE_LEAGUES.includes(k));

interface Props {
  setSlip: (fn: (prev: Leg[]) => Leg[]) => void;
}

// Scans are slow (a game log per player), so keep results for the session.
const scanCache = new Map<string, { games: Game[]; cands: Candidate[] }>();

export default function PropBuilder({ setSlip }: Props) {
  const [league, setLeague] = useState<LeagueKey>('nba');
  const [date, setDate] = useState(todayYMD);
  const [games, setGames] = useState<Game[]>([]);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legs, setLegs] = useState(3);
  const [mode, setMode] = useState<Mode>('balanced');
  const [gameId, setGameId] = useState('');
  const [parlay, setParlay] = useState<Parlay | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const key = `${league}|${date}`;
  const lines = LINE_LEAGUES.includes(league);

  useEffect(() => {
    const hit = scanCache.get(key);
    setCands(hit?.cands ?? null);
    setGames(hit?.games ?? []);
    setGameId('');
    setParlay(null);
    setError(null);
    if (!hit) fetchScoreboard(league, date).then(setGames, () => setGames([]));
  }, [key, league, date]);

  const pregame = games.filter((g) => g.state === 'pre');

  const scan = async () => {
    setError(null);
    setProgress('Loading games…');
    try {
      const g = games.length ? games : await fetchScoreboard(league, date);
      const c = await (lines ? scanGameLines : scanProps)(league, g, date, setProgress);
      scanCache.set(key, { games: g, cands: c });
      setGames(g);
      setCands(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const opts = useMemo(
    () => ({ legs, mode, gameId: gameId || undefined, maxPerGame: gameId ? legs : 2 }),
    [legs, mode, gameId]
  );

  const skipped = useMemo(() => new Set<string>(), [cands, opts]);

  useEffect(() => {
    setParlay(cands ? buildParlay(cands, opts) : null);
    setAdded(null);
  }, [cands, opts]);

  const shuffle = () => {
    if (!cands) return;
    setParlay(buildParlay(cands, { ...opts, shuffle: true }));
    setAdded(null);
  };

  const swap = (c: Candidate) => {
    if (!cands || !parlay) return;
    skipped.add(c.key); // don't offer a swapped-out leg straight back
    const next = swapLeg(cands, parlay, c, opts, skipped);
    if (next) setParlay(next);
    else setAdded(null);
  };

  const addToSlip = (list: Candidate[]) => {
    setSlip((prev) => [...prev, ...list.map(toLeg)]);
    setAdded(list.length === 1 ? candidateLabel(list[0]) : `${list.length} legs`);
  };

  const topLegs = useMemo(
    () => (cands ?? []).filter((c) => !gameId || c.game.id === gameId).slice(0, 25),
    [cands, gameId]
  );

  return (
    <section>
      <div className="pagehead">
        <h1>Parlay Builder</h1>
      </div>
      <p className="muted lede">
        {lines
          ? "College football has no player props, so this builds from DraftKings moneylines and spreads, picking the sides ESPN's FPI model rates higher than the price does."
          : "Pulls DraftKings player props for every game, checks each player's last 10 games against the line, and builds a parlay from the legs that clear most often relative to their price."}
      </p>

      <div className="chips">
        {BUILDER_LEAGUES.map((k) => (
          <button key={k} className={`chip ${k === league ? 'on' : ''}`} onClick={() => setLeague(k)}>
            {LEAGUES[k].label}
          </button>
        ))}
      </div>

      <div className="datebar">
        <button className="btn ghost" aria-label="Previous day" onClick={() => setDate((d) => shiftYMD(d, -1))}>
          ←
        </button>
        <label className="datepick">
          <span>{fmtDate(date)}</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <button className="btn ghost" aria-label="Next day" onClick={() => setDate((d) => shiftYMD(d, 1))}>
          →
        </button>
        <span className="spacer" />
        <span className="status-line">
          {pregame.length} game{pregame.length === 1 ? '' : 's'} not started
        </span>
        <button className="btn primary" onClick={scan} disabled={!!progress || !pregame.length}>
          {progress ? 'Scanning…' : `${cands ? 'Rescan' : 'Scan'} ${lines ? 'games' : 'props'}`}
        </button>
      </div>

      {progress && <div className="empty">{progress}</div>}
      {error && <div className="empty">Couldn't scan: {error}</div>}
      {!progress && !cands && !error && (
        <div className="empty">
          {pregame.length
            ? `Scan ${pregame.length} ${LEAGUES[league].label} game${pregame.length === 1 ? '' : 's'} to build a parlay. It takes a few seconds per game.`
            : `No ${LEAGUES[league].label} games left to start on ${fmtDate(date)}. Try another day.`}
        </div>
      )}

      {cands && !progress && (
        <>
          <div className="card controls">
            <div className="field">
              <span>Style</span>
              <div className="seg">
                {(Object.keys(MODES) as Mode[]).map((m) => (
                  <button key={m} className={m === mode ? 'on' : ''} onClick={() => setMode(m)} title={MODES[m].hint}>
                    {MODES[m].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Legs</span>
              <div className="seg">
                {[2, 3, 4, 5, 6].map((n) => (
                  <button key={n} className={n === legs ? 'on' : ''} onClick={() => setLegs(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {!lines && (
            <label className="field">
              <span>Games</span>
              <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
                <option value="">All games (max 2 legs per game)</option>
                {games
                  .filter((g) => cands.some((c) => c.game.id === g.id))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      Same game: {g.away.abbr} @ {g.home.abbr}
                    </option>
                  ))}
              </select>
            </label>
            )}
            <p className="muted small">{lines ? 'One leg per game, since a team’s moneyline and spread win or lose together.' : `${MODES[mode].hint}.`}</p>
          </div>

          {cands.length === 0 && (
            <div className="empty">
              {lines
                ? 'No games with both DraftKings odds and an ESPN FPI projection yet.'
                : 'No priced milestone props yet. DraftKings often posts them closer to game time.'}
            </div>
          )}
          {cands.length > 0 && !parlay && (
            <div className="empty">Not enough legs fit this style. Try another style, fewer legs, or all games.</div>
          )}

          {parlay && (
            <article className="card parlay">
              <header className="row between">
                <div>
                  <small className="muted">{parlay.legs.length}-leg parlay</small>
                  <h2>{fmtAmerican(parlay.odds)}</h2>
                </div>
                <div className="pstats">
                  <span>
                    <small>Book implies</small>
                    <b>{fmtPct(parlay.implied)}</b>
                  </span>
                  <span>
                    <small>{lines ? 'FPI blend says' : 'Recent form says'}</small>
                    <b className={parlay.est > parlay.implied ? 'pos' : 'neg'}>{fmtPct(parlay.est)}</b>
                  </span>
                </div>
              </header>
              <ul className="plegs">
                {parlay.legs.map((c) => (
                  <LegRow key={c.key} c={c} action={<button className="btn ghost sm" onClick={() => swap(c)}>Swap</button>} />
                ))}
              </ul>
              <StakeNote p={parlay.est} odds={parlay.odds} />
              {new Set(parlay.legs.map((l) => l.game.id)).size < parlay.legs.length && (
                <p className="warn small">
                  Includes same-game legs. Sportsbooks reprice those, so your book's price may be shorter than {fmtAmerican(parlay.odds)}.
                </p>
              )}
              <div className="actions">
                <button className="btn ghost" onClick={shuffle}>
                  ↻ Shuffle
                </button>
                <span className="spacer" />
                <button className="btn primary" onClick={() => addToSlip(parlay.legs)}>
                  Add to parlay slip
                </button>
              </div>
              {added && <p className="muted small">Added {added} to your slip. Review it from the bar at the bottom.</p>}
            </article>
          )}

          {topLegs.length > 0 && (
            <div className="card toplegs">
              <b>Best individual legs</b>
              <p className="muted small">
                {lines
                  ? "Ranked by how much more likely ESPN's FPI makes the side than the price implies."
                  : 'Ranked by how much more often the player has cleared the line than the price implies.'}
              </p>
              <ul className="plegs">
                {topLegs.map((c) => (
                  <LegRow key={c.key} c={c} action={<button className="btn ghost sm" onClick={() => addToSlip([c])}>+ Slip</button>} />
                ))}
              </ul>
            </div>
          )}

          <p className="muted small disclaimer">
            {lines
              ? "FPI is ESPN's power-rating model and is blended half-and-half with the market, which is usually sharper on its own. It doesn't know about injuries or weather after the scan. Parlays carry a large built-in house edge, so treat this as research, not a sure thing."
              : `Hit rates over 10 games are a small sample, not true probabilities, and they don't account for matchups, minutes or
            lineup news after the scan. Legs from the same game move together. Parlays carry a large built-in house edge, so treat
            this as research, not a sure thing.`}
          </p>
        </>
      )}
    </section>
  );
}

function LegRow({ c, action }: { c: Candidate; action: React.ReactNode }) {
  return (
    <li className="pleg">
      <div className="pmain">
        <b>{candidateLabel(c)}</b>
        <small className="muted">
          {c.team} · {c.game.away.abbr} @ {c.game.home.abbr}
          {c.gtd && <span className="inj"> · questionable</span>}
        </small>
        {c.kind === 'line' ? (
          <small>
            {c.detail} · book {fmtPct(breakEven(c.odds))} vs blend <span className={c.edge > 0 ? 'pos' : 'neg'}>{fmtPct(c.est)}</span>
          </small>
        ) : (
          <>
            <span className="hitbar" title={`${c.hits} of last ${c.n} games`}>
              <i style={{ width: `${(c.hits / c.n) * 100}%` }} />
            </span>
            <small>
              Hit {c.hits}/{c.n} · avg {c.avg.toFixed(1)} · book {fmtPct(breakEven(c.odds))} vs form{' '}
              <span className={c.edge > 0 ? 'pos' : 'neg'}>{fmtPct(c.est)}</span>
            </small>
          </>
        )}
      </div>
      <div className="pside">
        <b>{fmtAmerican(c.odds)}</b>
        {kellyUnits(c.est, c.odds) > 0 && <small className="muted">stake {kellyUnits(c.est, c.odds)}u</small>}
        {action}
      </div>
    </li>
  );
}

/** Quarter-Kelly stake for a whole parlay, from the product of its leg estimates. */
export function StakeNote({ p, odds }: { p: number; odds: number }) {
  const u = kellyUnits(p, odds);
  return (
    <p className="muted small stakenote">
      {u > 0 ? (
        <>
          Suggested stake: <b>{u}u</b> (a cautious Kelly: half the model's edge, an eighth of the Kelly stake, at most 3% of bankroll). Set your bankroll in Bets to size it to you.
        </>
      ) : (
        <>The estimate doesn't beat this price, so Kelly says no bet. If you play it, keep it small.</>
      )}
    </p>
  );
}
