import { useCallback, useEffect, useState } from 'react';
import { fetchLeaderboard, LEAGUES, type FieldEvent, type LeagueKey } from '../espn';
import { fmtDate } from '../store';

const REFRESH_MS = 2 * 60_000;
const SHOWN = 25;

/** Golf leaderboards and race running orders: one card per tournament or race weekend. */
export default function Leaderboard({ league, date }: { league: LeagueKey; date: string }) {
  const [events, setEvents] = useState<FieldEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setEvents(await fetchLeaderboard(league, date, signal));
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message || 'Could not reach ESPN');
      }
    },
    [league, date]
  );

  useEffect(() => {
    setEvents(null);
    const ctrl = new AbortController();
    load(ctrl.signal);
    const t = setInterval(() => !document.hidden && load(), REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [load]);

  const label = LEAGUES[league].label;
  if (error) return <div className="empty">Couldn't load {label}: {error}</div>;
  if (!events) return <div className="empty">Loading {label}…</div>;
  if (!events.length) return <div className="empty">No {label} event on {fmtDate(date)}.</div>;
  return (
    <div className="games">
      {events.map((e) => (
        <FieldCard key={e.id} event={e} />
      ))}
    </div>
  );
}

function FieldCard({ event: e }: { event: FieldEvent }) {
  const golf = LEAGUES[e.league].group === 'Golf';
  const withRows = e.sessions.filter((s) => s.rows.length);
  // Default to the session in progress, else the latest one with results.
  const best = withRows.find((s) => s.state === 'in') ?? withRows[withRows.length - 1];
  const [pick, setPick] = useState(best ? e.sessions.indexOf(best) : 0);
  const [all, setAll] = useState(false);
  const session = e.sessions[pick];
  const rows = session?.rows ?? [];
  const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <article className={`game field ${e.state}`}>
      <div className="fhead">
        <div>
          <b>{e.name}</b>
          <small className="muted">{[e.venue, e.state === 'pre' ? when(e.start) : e.detail].filter(Boolean).join(' · ')}</small>
        </div>
        <span className={`state ${e.state}`}>{e.state === 'in' ? 'Live' : e.state === 'post' ? 'Final' : 'Upcoming'}</span>
      </div>

      {e.sessions.length > 1 && (
        <div className="chips small">
          {e.sessions.map((s, i) => (
            <button key={i} className={`chip ${i === pick ? 'on' : ''}`} onClick={() => setPick(i)}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {session && !rows.length && (
        <p className="muted small">
          {session.state === 'pre' ? `${session.label} starts ${when(session.start)}. The field posts closer to the start.` : 'No results posted yet.'}
        </p>
      )}

      {rows.length > 0 && (
        <table className="board">
          <thead>
            <tr>
              <th>Pos</th>
              <th className="l">{golf ? 'Player' : 'Driver'}</th>
              {golf && <th title="Latest round, to par">Rd</th>}
              {golf && <th>Total</th>}
            </tr>
          </thead>
          <tbody>
            {(all ? rows : rows.slice(0, SHOWN)).map((r) => (
              <tr key={r.id} className={r.winner ? 'won' : ''}>
                <td>{r.pos}</td>
                <td className="l">
                  {r.flag && <img src={r.flag} alt="" width={16} height={16} loading="lazy" />} {r.name}
                </td>
                {golf && <td>{r.today ?? ''}</td>}
                {golf && <td><b>{r.score ?? ''}</b></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > SHOWN && (
        <button className="linkbtn" onClick={() => setAll(!all)}>
          {all ? 'Show top 25' : `Show all ${rows.length}`}
        </button>
      )}
      <p className="muted small">Picks like outrights and matchups can be tracked from Bets → + Add bet.</p>
    </article>
  );
}
