import { useEffect, useState } from 'react';
import { fetchScoreboard, LEAGUES, type Game, type LeagueKey } from '../espn';
import { fmtAmerican, kellyUnits, type Bet, type Leg } from '../bets';
import { lineMoves, type Move } from '../movement';
import { gameWeather, passGameFactor, weatherNote, type GameWeather } from '../weather';
import { candidateLabel, scanProps, toLeg, type Candidate } from '../propgen';
import { LINE_LEAGUES, scanGameLines } from '../gamelines';
import { loadSnapshots } from '../snapshots';
import { SPORT_LABEL } from '../dfs';
import { fmtDate, shiftYMD, todayYMD } from '../store';
import LiveSweat from './LiveSweat';
import AlertsToggle from './AlertsToggle';
import { ProGate } from './Pro';

const MOVE_LEAGUES: LeagueKey[] = ['nfl', 'cfb', 'nba', 'mcbb', 'nhl', 'mlb'];
const time = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export default function Today({ bets, setSlip }: { bets: Bet[]; setSlip: (fn: (prev: Leg[]) => Leg[]) => void }) {
  const today = todayYMD();
  const [games, setGames] = useState<Game[] | null>(null);
  const [weather, setWeather] = useState<{ g: Game; w: GameWeather }[] | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(MOVE_LEAGUES.map((lg) => fetchScoreboard(lg, today).catch(() => [] as Game[]))).then(async (lists) => {
      const all = lists.flat();
      if (!live) return;
      setGames(all);
      // Weather watch: outdoor football today and tomorrow.
      const tomorrow = await Promise.all((['nfl', 'cfb'] as LeagueKey[]).map((lg) => fetchScoreboard(lg, shiftYMD(today, 1)).catch(() => [] as Game[])));
      const football = [...all, ...tomorrow.flat()].filter((g) => (g.league === 'nfl' || g.league === 'cfb') && g.state === 'pre' && g.indoor === false && g.odds);
      // Ask for every game at once: the weather module sends them as one batched request.
      const all2 = await Promise.all(football.map(async (g) => ({ g, w: await gameWeather(g) })));
      const found = all2.filter((x): x is { g: Game; w: GameWeather } => !!x.w && passGameFactor(x.w) < 1);
      if (live) setWeather(found.sort((a, b) => b.w.windMph - a.w.windMph));
    });
    return () => {
      live = false;
    };
  }, [today]);

  const moves = (games ?? [])
    .filter((g) => g.state === 'pre')
    .flatMap((g) => lineMoves(g).map((m) => ({ g, m })))
    .filter(({ m }) => m.big)
    .sort((a, b) => b.m.size - a.m.size)
    .slice(0, 8);

  return (
    <section>
      <div className="hero">
        <p className="kicker">{fmtDate(today)}</p>
        <h1>Today on the board</h1>
      </div>
      <AlertsToggle />
      <LiveSweat bets={bets} />

      <div className="todaygrid">
        <div className="card tcard">
          <h2>Biggest line moves</h2>
          <p className="muted small">Games where DraftKings' line has moved the most since opening. Often sharp money or injury news.</p>
          {games == null ? (
            <p className="muted small">Loading…</p>
          ) : moves.length ? (
            <ul className="rlist">
              {moves.map(({ g, m }: { g: Game; m: Move }, i) => (
                <li key={i}>
                  <span>
                    <a href={`#${g.league}`}>{`${g.away.abbr} @ ${g.home.abbr}`}</a> <small className="muted">{LEAGUES[g.league].label} · {time(g.start)}</small>
                  </span>
                  <b>{m.text}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No big moves on today's games yet.</p>
          )}
        </div>

        <div className="card tcard">
          <h2>Weather watch</h2>
          <p className="muted small">Outdoor football games today and tomorrow where wind or rain should slow the passing game.</p>
          {weather == null ? (
            <p className="muted small">Checking forecasts…</p>
          ) : weather.length ? (
            <ul className="rlist">
              {weather.slice(0, 8).map(({ g, w }) => (
                <li key={g.id}>
                  <span>
                    <a href={`#${g.league}`}>{`${g.away.abbr} @ ${g.home.abbr}`}</a> <small className="muted">{LEAGUES[g.league].label} · {time(g.start)}</small>
                  </span>
                  <b className="inj">{weatherNote(w)}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No weather worries for outdoor games.</p>
          )}
        </div>
      </div>

      <ProGate feature="Best edges today" blurb="Scans tonight's props and college lines for prices the numbers say are off, ranked by edge with a stake size.">
        <BestEdges games={games} setSlip={setSlip} />
      </ProGate>
      <FantasyValues />
    </section>
  );
}

/** Scans NBA and NHL props plus college football lines and keeps the strongest edges, with stake sizes. */
function BestEdges({ games, setSlip }: { games: Game[] | null; setSlip: (fn: (prev: Leg[]) => Leg[]) => void }) {
  const [edges, setEdges] = useState<Candidate[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const today = todayYMD();

  const scan = async () => {
    if (!games) return;
    setProgress('Starting…');
    const all: Candidate[] = [];
    for (const lg of ['nba', 'nhl'] as LeagueKey[]) {
      const list = games.filter((g) => g.league === lg && g.state === 'pre');
      if (list.length) all.push(...(await scanProps(lg, list, today, (m) => setProgress(`${LEAGUES[lg].label}: ${m}`)).catch(() => [])));
    }
    for (const lg of LINE_LEAGUES) {
      const list = games.filter((g) => g.league === lg && g.state === 'pre');
      if (list.length) all.push(...(await scanGameLines(lg, list, today, (m) => setProgress(`${LEAGUES[lg].label}: ${m}`)).catch(() => [])));
    }
    // Edges with a real price: skip heavy favorites and lottery tickets.
    setEdges(all.filter((c) => c.odds >= -250 && c.odds <= 400 && c.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 8));
    setProgress(null);
  };

  return (
    <div className="card tcard wide">
      <div className="row between">
        <h2>Best edges today</h2>
        <button className="btn primary sm" onClick={scan} disabled={!games || !!progress}>
          {progress ? 'Scanning…' : edges ? 'Rescan' : 'Find edges'}
        </button>
      </div>
      <p className="muted small">
        NBA and NHL player props (recent form vs. the price) and college football and basketball sides (ESPN's FPI and BPI vs. the price), ranked by edge,
        with a cautious Kelly stake.
      </p>
      {progress && <p className="muted small">{progress}</p>}
      {edges && !edges.length && !progress && <p className="muted small">No edges worth listing right now.</p>}
      {edges && edges.length > 0 && (
        <ul className="plegs">
          {edges.map((c) => (
            <li key={c.key} className="pleg">
              <div className="pmain">
                <b>{candidateLabel(c)}</b>
                <small className="muted">
                  {LEAGUES[c.league].label} · {c.game.away.abbr} @ {c.game.home.abbr} ·{' '}
                  {c.kind === 'line' ? c.detail : `hit ${c.hits}/${c.n}`} · edge <span className="pos">+{(c.edge * 100).toFixed(1)}</span>
                </small>
              </div>
              <div className="pside">
                <b>{fmtAmerican(c.odds)}</b>
                <small className="muted">stake {kellyUnits(c.est, c.odds)}u</small>
                <button
                  className="btn ghost sm"
                  disabled={added.has(c.key)}
                  onClick={() => {
                    setSlip((prev) => [...prev, toLeg(c)]);
                    setAdded((s) => new Set(s).add(c.key));
                  }}
                >
                  {added.has(c.key) ? 'Added' : '+ Slip'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Top values from today's projections, if any were built. */
function FantasyValues() {
  const today = todayYMD();
  const snaps = loadSnapshots().filter((s) => s.date === today);
  return (
    <div className="card tcard wide">
      <h2>Fantasy values</h2>
      {!snaps.length ? (
        <p className="muted small">
          Build projections in the <a href="#fantasy">Fantasy</a> tab and today's best values show up here.
        </p>
      ) : (
        snaps.slice(0, 2).map((s) => {
          const top = [...s.players]
            .filter((p) => p.proj >= (s.sport === 'nfl' ? 8 : s.sport === 'nba' ? 15 : 6))
            .sort((a, b) => b.proj / b.salary - a.proj / a.salary)
            .slice(0, 6);
          return (
            <div key={s.slateId}>
              <small className="muted">
                {s.site === 'dk' ? 'DraftKings' : 'FanDuel'} {SPORT_LABEL[s.sport]} · {s.label}
              </small>
              <ul className="rlist">
                {top.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.name} <small className="muted">{p.pos.join('/')} · {p.team}</small>
                    </span>
                    <small className="muted">${p.salary.toLocaleString()} · {p.proj.toFixed(1)} pts</small>
                    <b>{((p.proj / p.salary) * 1000).toFixed(2)}x</b>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
      <p className="muted small">
        Lineups saved from the generator can be checked for late swaps from the lineup's editor in <a href="#fantasy">Fantasy</a>.
      </p>
    </div>
  );
}
