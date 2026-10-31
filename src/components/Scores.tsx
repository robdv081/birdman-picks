import { useCallback, useEffect, useState } from 'react';
import { fetchInjuries, fetchScoreboard, LEAGUE_KEYS, LEAGUES, type Game, type Injury, type LeagueKey, type Side } from '../espn';
import { breakEven, fmtAmerican, fmtLine, fmtPct, type Bet, type BetSide, type Market } from '../bets';
import { fmtDate, shiftYMD, todayYMD } from '../store';
import LiveSweat from './LiveSweat';

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

  useEffect(() => {
    setGames(null);
    const ctrl = new AbortController();
    load(ctrl.signal);
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [load]);

  const tracked = new Set(bets.filter((b) => b.eventId).map((b) => b.eventId));
  const live = games?.filter((g) => g.state === 'in').length ?? 0;

  return (
    <section>
      <div className="hero">
        <p className="kicker">Your daily sports desk</p>
        <h1>The games move. Stay on the board.</h1>
      </div>

      <LiveSweat bets={bets} compact />

      <div className="chips" role="tablist" aria-label="League">
        {LEAGUE_KEYS.map((k) => (
          <a key={k} role="tab" aria-selected={k === league} className={`chip ${k === league ? 'on' : ''}`} href={`#${k}`}>
            {LEAGUES[k].label}
          </a>
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
        {date !== todayYMD() && (
          <button className="btn ghost" onClick={() => setDate(todayYMD())}>
            Today
          </button>
        )}
        <span className="spacer" />
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
      </div>

      {games == null && !error && <div className="empty">Loading {LEAGUES[league].label} games…</div>}
      {games?.length === 0 && <div className="empty">No {LEAGUES[league].label} games on {fmtDate(date)}.</div>}

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
  const matchup = `${g.away.abbr} @ ${g.home.abbr}`;
  const winner = g.completed && g.away.score != null && g.home.score != null ? (g.away.score > g.home.score ? 'away' : g.home.score > g.away.score ? 'home' : null) : null;
  const time = new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const track = (market: Market, side: BetSide, odds: number | undefined, line: number | undefined, selection: string) =>
    onTrack({
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
            <span className="abbr">{t.abbr}</span>
            {(t.record || inj) && (
              <small>
                {t.record}
                {t.record && inj && ' · '}
                {inj && <span className="inj">{inj}</span>}
              </small>
            )}
          </span>
          <span className="score">{g.state === 'pre' ? '' : t.score ?? '—'}</span>
        </div>
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
    <article className={`game ${g.state}`}>
      <div className="ghead">
        <span className={`state ${g.state}`}>
          {g.state === 'pre' ? time : g.detail}
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
      <div className="gfoot">
        <span>{[g.venue, g.broadcast].filter(Boolean).join(' · ')}</span>
        <span className="spacer" />
        {o && <span className="muted">{open ? `${o.provider} · tap a price` : `${o.provider} closing line`}</span>}
        <button className="linkbtn" onClick={onDetails}>
          {g.state === 'pre' ? 'Injuries & props' : 'Box score'} →
        </button>
      </div>
    </article>
  );
}
