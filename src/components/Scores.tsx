import { useCallback, useEffect, useState } from 'react';
import { fetchInjuries, fetchScoreboard, LEAGUES, leaguesIn, SPORT_GROUPS, type Game, type Injury, type LeagueKey, type Side } from '../espn';
import { breakEven, fmtAmerican, fmtLine, fmtPct, type Bet, type BetSide, type Market } from '../bets';
import { fmtDate, shiftYMD, todayYMD } from '../store';
import { lineMoves } from '../movement';
import { gameWeather, passGameFactor, weatherNote, type GameWeather } from '../weather';
import LiveSweat from './LiveSweat';
import Leaderboard from './Leaderboard';

interface Props {
  league: LeagueKey;
  bets: Bet[];
  onTrack: (draft: Partial<Bet>) => void;
  onDetails: (game: Game, date: string) => void;
}

const REFRESH_MS = 60_000;
const INJURY_REFRESH_MS = 10 * 60_000;

export function injurySummary(list: Injury[] = []) {
  const out = list.filter((i) => i.severity === 'out').length;
  const q = list.length - out;
  return [out && `${out} out`, q && `${q} GTD`].filter(Boolean).join(', ');
}

export default function Scores({ league, bets, onTrack, onDetails }: Props) {
  const [date, setDate] = useState(todayYMD);
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [injuries, setInjuries] = useState<Record<string, Injury[]>>({});

  useEffect(() => {
    setInjuries({});
    if (LEAGUES[league].kind !== 'team' || LEAGUES[league].group === 'Soccer') return;
    const ctrl = new AbortController();
    const get = () => fetchInjuries(league, ctrl.signal).then(setInjuries, () => {});
    get();
    const t = setInterval(get, INJURY_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [league]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const g = await fetchScoreboard(league, date, signal);
        g.sort((a, b) => a.start.localeCompare(b.start));
        setGames(g);
        setError(null);
        setChecked(new Date());
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message || 'Could not reach ESPN');
      } finally {
        setLoading(false);
      }
    },
    [league, date]
  );

  const field = LEAGUES[league].kind === 'field';
  useEffect(() => {
    setGames(null);
    if (field) return;
    const ctrl = new AbortController();
    load(ctrl.signal);
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [load, field]);

  // Keep the selected sport and league tabs in view on narrow screens.
  useEffect(() => {
    document.querySelectorAll('.chips .chip.on').forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
  }, [league]);

  const noun = LEAGUES[league].group === 'Fighting' ? 'fights' : LEAGUES[league].group === 'Tennis' ? 'matches' : 'games';
  const tracked = new Set(bets.filter((b) => b.eventId).map((b) => b.eventId));
  const live = games?.filter((g) => g.state === 'in').length ?? 0;

  return (
    <section>
      <div className="hero">
        <p className="kicker">Your daily sports desk</p>
        <h1>The games move. Stay on the board.</h1>
      </div>

      <LiveSweat bets={bets} compact />

      <div className="chips" role="tablist" aria-label="Sport">
        {SPORT_GROUPS.map((g) => (
          <a
            key={g}
            role="tab"
            aria-selected={g === LEAGUES[league].group}
            className={`chip ${g === LEAGUES[league].group ? 'on' : ''}`}
            href={`#${leaguesIn(g)[0]}`}
          >
            {g}
          </a>
        ))}
      </div>
      {leaguesIn(LEAGUES[league].group).length > 1 && (
        <div className="chips small" role="tablist" aria-label="League">
          {leaguesIn(LEAGUES[league].group).map((k) => (
            <a key={k} role="tab" aria-selected={k === league} className={`chip ${k === league ? 'on' : ''}`} href={`#${k}`}>
              {LEAGUES[k].label}
            </a>
          ))}
        </div>
      )}

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
        {date !== todayYMD() && (
          <button className="btn ghost" onClick={() => setDate(todayYMD())}>
            Today
          </button>
        )}
        <span className="spacer" />
        {!field && (<>
        <span className="status-line">
          <span className={`dot ${error ? 'bad' : live ? 'live' : ''}`} />
          {error
            ? `Couldn't refresh: ${error}`
            : checked
              ? `${live ? `${live} live · ` : ''}Updated ${checked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : 'Loading…'}
        </span>
        <button className="btn" onClick={() => load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        </>)}
      </div>

      {field && <Leaderboard league={league} date={date} />}
      {!field && games == null && !error && <div className="empty">Loading {LEAGUES[league].label} {noun}…</div>}
      {!field && games?.length === 0 && <div className="empty">No {LEAGUES[league].label} {noun} on {fmtDate(date)}.</div>}

      <div className="games">
        {games?.map((g) => (
          <GameCard
            key={g.id}
            game={g}
            date={date}
            tracked={tracked.has(g.id)}
            injuries={injuries}
            onTrack={onTrack}
            onDetails={() => onDetails(g, date)}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  game: Game;
  date: string;
  tracked: boolean;
  injuries: Record<string, Injury[]>;
  onTrack: Props['onTrack'];
  onDetails: () => void;
}

function GameCard({ game: g, date, tracked, injuries, onTrack, onDetails }: CardProps) {
  const o = g.odds;
  const open = g.state === 'pre';
  const kind = LEAGUES[g.league].kind;
  const versus = kind === 'versus';
  const matchup = versus ? `${g.away.name} vs ${g.home.name}` : `${g.away.abbr} @ ${g.home.abbr}`;
  const winner = g.completed
    ? g.away.winner
      ? 'away'
      : g.home.winner
        ? 'home'
        : g.away.score != null && g.home.score != null
          ? g.away.score > g.home.score ? 'away' : g.home.score > g.away.score ? 'home' : null
          : null
    : null;
  const time = new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const moves = g.state === 'pre' ? lineMoves(g) : [];
  const [wx, setWx] = useState<GameWeather | null>(null);
  useEffect(() => {
    let live = true;
    gameWeather(g).then((w) => live && setWx(w));
    return () => {
      live = false;
    };
  }, [g.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const wxNote = weatherNote(wx);

  const L = o?.links;
  const linkFor = (market: Market, side: BetSide) =>
    market === 'ml'
      ? side === 'home' ? L?.homeML : side === 'away' ? L?.awayML : L?.draw
      : market === 'spread'
        ? side === 'home' ? L?.homeSpread : L?.awaySpread
        : side === 'over' ? L?.over : L?.under;
  const track = (market: Market, side: BetSide, odds: number | undefined, line: number | undefined, selection: string) =>
    onTrack({
      dkLink: linkFor(market, side),
      league: g.league,
      eventId: g.id,
      date,
      matchup,
      market,
      side,
      line,
      odds: odds ?? -110,
      selection,
      book: o?.provider,
    });

  const cell = (
    market: Market,
    side: BetSide,
    odds: number | undefined,
    line: number | undefined,
    label: string,
    selection: string
  ) => {
    if (odds == null && line == null) return <span className="odd none">—</span>;
    return (
      <button
        className="odd"
        disabled={!open}
        title={odds != null ? `Break-even ${fmtPct(breakEven(odds))}` : undefined}
        onClick={() => track(market, side, odds, line, selection)}
      >
        <b>{label}</b>
        {odds != null && market !== 'ml' && <small>{fmtAmerican(odds)}</small>}
      </button>
    );
  };

  const row = (side: 'away' | 'home', t: Side) => {
    const sp = side === 'away' ? o?.awaySpread : o?.homeSpread;
    const ml = side === 'away' ? o?.awayML : o?.homeML;
    const tot = side === 'away' ? o?.over : o?.under;
    const ou: BetSide = side === 'away' ? 'over' : 'under';
    const inj = g.state === 'post' ? '' : injurySummary(injuries[t.id]);
    return (
      <div className={`trow ${winner && winner !== side ? 'lost' : ''}`}>
        <div className="team">
          {t.logo ? <img src={t.logo} alt="" width={28} height={28} loading="lazy" /> : <span className="nologo" />}
          <span className="tname">
            <span className="full">{t.name}</span>
            <span className="abbr">{versus ? t.name : t.abbr}</span>
            {(t.record || inj) && (
              <small>
                {t.record}
                {t.record && inj && ' · '}
                {inj && <span className="inj">{inj}</span>}
              </small>
            )}
          </span>
          <span className="score">{g.state === 'pre' ? '' : t.score ?? (versus ? (winner === side ? 'W' : '') : '—')}</span>
        </div>
        {!o && versus && open && (
          <button className="odd pick" onClick={() => track('ml', side, undefined, undefined, `${t.name} to win`)}>
            <b>Pick</b>
          </button>
        )}
        {o && (
          <>
            {cell('ml', side, ml, undefined, fmtAmerican(ml), `${t.abbr} ML`)}
            {cell('spread', side, sp?.odds, sp?.line, fmtLine(sp?.line), `${t.abbr} ${fmtLine(sp?.line)}`)}
            {cell(
              'total',
              ou,
              tot?.odds,
              tot?.line,
              `${ou === 'over' ? 'O' : 'U'} ${tot?.line ?? ''}`,
              `${matchup} ${ou === 'over' ? 'Over' : 'Under'} ${tot?.line ?? ''}`
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <article className={`game ${g.state} ${o ? '' : 'noodds'}`}>
      <div className="ghead">
        <span className={`state ${g.state}`}>
          {g.state === 'pre' ? time : g.detail}
          {g.note && <span className="muted gnote"> · {g.note}</span>}
          {tracked && <span className="pill tracked">Tracked</span>}
        </span>
        {o && (
          <span className="cols">
            <span>ML</span>
            <span>Spread</span>
            <span>Total</span>
          </span>
        )}
      </div>
      {row('away', g.away)}
      {row('home', g.home)}
      {o?.draw != null && (
        <div className={`trow draw ${g.completed && winner == null ? '' : g.completed ? 'lost' : ''}`}>
          <div className="team">
            <span className="nologo" />
            <span className="tname">
              <span className="full">Draw</span>
              <span className="abbr">Draw</span>
              <small>3-way moneyline</small>
            </span>
            <span className="score" />
          </div>
          {cell('ml', 'draw', o.draw, undefined, fmtAmerican(o.draw), `${matchup} Draw`)}
          <span />
          <span />
        </div>
      )}
      {(moves.length > 0 || wxNote || (g.indoor && (g.league === 'nfl' || g.league === 'cfb'))) && (
        <div className="gnotes">
          {moves.length > 0 && (
            <span>
              {moves.some((m) => m.big) && <span className="pill tracked">Big move</span>} Opened: {moves.map((m) => m.text).join(' · ')}
            </span>
          )}
          {wxNote && (
            <span className={passGameFactor(wx) < 1 ? 'inj' : ''}>
              {g.weather?.text ? `${g.weather.text} · ` : ''}
              {wxNote}
              {passGameFactor(wx) < 1 ? ' · tough passing conditions' : ''}
            </span>
          )}
          {g.indoor && (g.league === 'nfl' || g.league === 'cfb') && <span>Indoors</span>}
        </div>
      )}
      <div className="gfoot">
        <span>{[g.venue, g.broadcast].filter(Boolean).join(' · ')}</span>
        <span className="spacer" />
        {o && <span className="muted">{open ? `${o.provider} · tap a price` : `${o.provider} closing line`}</span>}
        {kind === 'team' && (
          <button className="linkbtn" onClick={onDetails}>
            {g.state === 'pre' ? (LEAGUES[g.league].group === 'Soccer' ? 'Match details' : 'Injuries & props') : 'Box score'} →
          </button>
        )}
      </div>
    </article>
  );
}
