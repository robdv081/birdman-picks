import { useEffect, useState } from 'react';
import { fetchSummary, type Game, type GameSummary, type Injury } from '../espn';
import type { Bet } from '../bets';
import { fantasyPoints } from '../stats';
import { injuryRipple, type Ripple } from '../ripple';

function RipplePanel({ teamId, gameId, player }: { teamId: string; gameId?: string; player: string }) {
  const [r, setR] = useState<Ripple | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    injuryRipple(teamId, player, gameId).then(setR, (e) => setError(e.message));
  }, [teamId, gameId, player]);

  if (error) return <p className="muted small">Couldn't load: {error}</p>;
  if (!r) return <p className="muted small">Comparing games with and without {player}…</p>;
  if (r.note) return <p className="muted small">{r.note}</p>;
  const f = (n: number) => n.toFixed(1);
  return (
    <div className="ripple">
      <small className="muted">
        Teammates in the {r.missed} games {r.injured} missed vs. the {r.played} he played (this season and last, on this team):
      </small>
      <table className="box">
        <thead>
          <tr>
            <th className="pname">Player</th>
            <th>PTS</th>
            <th>REB</th>
            <th>AST</th>
            <th>MIN</th>
            <th title="FanDuel points per game, without minus with">FD ±</th>
            {gameId && <th title="Tonight's points projection from DraftKings props">Line</th>}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.athleteId}>
              <td className="pname">
                {x.name} <small>{x.withoutN}g</small>
              </td>
              {(['pts', 'reb', 'ast', 'min'] as const).map((s) => {
                const d = x.without[s] - x.with[s];
                return (
                  <td key={s} title={`${f(x.with[s])} with → ${f(x.without[s])} without`}>
                    {f(x.without[s])}
                    <small className={d > 0.5 ? 'pos' : d < -0.5 ? 'neg' : 'muted'}> {d >= 0 ? '+' : ''}{f(d)}</small>
                  </td>
                );
              })}
              <td className={x.deltaFp > 0 ? 'pos' : 'neg'}>
                {x.deltaFp >= 0 ? '+' : ''}
                {f(x.deltaFp)}
              </td>
              {gameId && (
                <td className={x.marketPts != null && x.without.pts > x.marketPts + 2 ? 'pos' : ''}>
                  {x.marketPts != null ? f(x.marketPts) : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {gameId && (
        <small className="muted">
          Green line: he's averaged 2+ points more without {r.injured} than tonight's market expects. Books often price injury news in
          fast, so check the line hasn't already moved.
        </small>
      )}
    </div>
  );
}

interface Props {
  game: Game;
  date: string;
  onClose: () => void;
  onTrack: (draft: Partial<Bet>) => void;
}

type Tab = 'injuries' | 'leaders' | 'box';

export default function GameDetails({ game: g, date, onClose, onTrack }: Props) {
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasBox = g.state !== 'pre';
  const [tab, setTab] = useState<Tab>(hasBox ? 'box' : 'injuries');
  const [teamIdx, setTeamIdx] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const get = () =>
      fetchSummary(g.league, g.id, ctrl.signal).then(
        (s) => {
          setSummary(s);
          setError(null);
        },
        (e) => e.name !== 'AbortError' && setError(e.message)
      );
    get();
    const t = g.state === 'in' ? setInterval(get, 60_000) : undefined;
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [g.league, g.id, g.state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matchup = `${g.away.abbr} @ ${g.home.abbr}`;
  const trackProp = (player = '') =>
    onTrack({ league: g.league, eventId: g.id, date, matchup, market: 'prop', side: 'over', odds: -110, player, book: g.odds?.provider });
  const teams = [g.away, g.home];
  const box = summary?.box ?? [];
  const team = box[teamIdx];

  return (
    <div className="scrim drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={`${matchup} details`}>
        <header className="dhead">
          <div className="dscore">
            {teams.map((t) => (
              <span key={t.id} className="dteam">
                {t.logo && <img src={t.logo} alt="" width={32} height={32} />}
                <b>{t.abbr}</b>
                {g.state !== 'pre' && <span className="score">{t.score ?? '—'}</span>}
              </span>
            ))}
          </div>
          <button className="x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="muted dmeta">
          {g.detail}
          {g.venue && ` · ${g.venue}`}
          {g.link && (
            <>
              {' · '}
              <a href={g.link} target="_blank" rel="noreferrer">
                ESPN ↗
              </a>
            </>
          )}
        </p>

        {g.state !== 'post' && (
          <button className="btn primary block" onClick={() => trackProp()}>
            + Track a player prop
          </button>
        )}

        <div className="chips small">
          {hasBox && (
            <button className={`chip ${tab === 'box' ? 'on' : ''}`} onClick={() => setTab('box')}>
              Box score
            </button>
          )}
          <button className={`chip ${tab === 'injuries' ? 'on' : ''}`} onClick={() => setTab('injuries')}>
            Injuries
          </button>
          <button className={`chip ${tab === 'leaders' ? 'on' : ''}`} onClick={() => setTab('leaders')}>
            {hasBox ? 'Game leaders' : 'Season leaders'}
          </button>
        </div>

        {error && <div className="empty">Couldn't load details: {error}</div>}
        {!summary && !error && <div className="empty">Loading…</div>}

        {summary && tab === 'injuries' && (
          <div className="dsection">
            {teams.map((t) => (
              <InjuryList
                key={t.id}
                abbr={t.abbr}
                list={summary.injuries[t.id] ?? []}
                ripple={g.league === 'nba' ? { teamId: t.id, gameId: g.state === 'pre' ? g.id : undefined } : undefined}
              />
            ))}
          </div>
        )}

        {summary && tab === 'leaders' && (
          <div className="dsection leaders">
            {summary.leaders.length === 0 && <p className="muted">No leaders posted yet.</p>}
            {summary.leaders.map((t) => (
              <div key={t.teamId}>
                <h3>{t.abbr}</h3>
                <ul>
                  {t.items.map((it) => (
                    <li key={it.category}>
                      <small>{it.category}</small>
                      <span>{it.player}</span>
                      <b>{it.value}</b>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {summary && tab === 'box' && (
          <div className="dsection">
            {box.length === 0 ? (
              <p className="muted">No box score yet.</p>
            ) : (
              <>
                <div className="seg">
                  {box.map((t, i) => (
                    <button key={t.teamId} className={i === teamIdx ? 'on' : ''} onClick={() => setTeamIdx(i)}>
                      {t.abbr}
                    </button>
                  ))}
                </div>
                {g.state !== 'post' && <p className="muted small">Tap a player to track a prop on them.</p>}
                {team?.groups
                  .filter((gr) => gr.rows.length)
                  .map((gr, gi) => (
                    <div key={gi} className="tablewrap">
                      <table className="box">
                        <thead>
                          <tr>
                            <th className="pname">{gr.name ? gr.name.replace(/([A-Z])/g, ' $1') : 'Player'}</th>
                            {gr.labels.map((l) => (
                              <th key={l}>{l}</th>
                            ))}
                            {g.league === 'nba' && <th title="FanDuel fantasy points">FD</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {gr.rows.map((r) => (
                            <tr key={r.id} className={r.dnp ? 'dnp' : ''}>
                              <td className="pname">
                                {g.state !== 'post' ? (
                                  <button className="linkbtn" onClick={() => trackProp(r.name)}>
                                    {r.name}
                                  </button>
                                ) : (
                                  r.name
                                )}
                                {r.pos && <small> {r.pos}</small>}
                              </td>
                              {r.dnp ? (
                                <td colSpan={gr.labels.length + (g.league === 'nba' ? 1 : 0)} className="muted">
                                  Did not play
                                </td>
                              ) : (
                                <>
                                  {gr.labels.map((l, i) => (
                                    <td key={l}>{r.stats[i]}</td>
                                  ))}
                                  {g.league === 'nba' && <td>{fantasyPoints([summary], r.name, 'fd-nba')?.toFixed(1)}</td>}
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function InjuryList({ abbr, list, ripple }: { abbr: string; list: Injury[]; ripple?: { teamId: string; gameId?: string } }) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  return (
    <div className="injlist">
      <h3>{abbr}</h3>
      {list.length === 0 ? (
        <p className="muted">No reported injuries.</p>
      ) : (
        <ul>
          {list.map((i, k) => (
            <li key={k}>
              <div>
                <b>{i.player}</b>
                {i.pos && <small> {i.pos}</small>}
                <span className={`pill ${i.severity === 'out' ? 'lost' : 'pending'}`}>{i.status}</span>
              </div>
              {(i.detail || i.returnDate) && (
                <small className="muted">
                  {i.detail}
                  {i.returnDate && ` · est. return ${new Date(i.returnDate + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
                </small>
              )}
              {i.comment && <small className="comment">{i.comment}</small>}
              {ripple && i.severity === 'out' && (
                <button className="linkbtn small" onClick={() => setOpenFor(openFor === i.player ? null : i.player)}>
                  {openFor === i.player ? 'Hide' : 'Who benefits?'} →
                </button>
              )}
              {ripple && openFor === i.player && <RipplePanel teamId={ripple.teamId} gameId={ripple.gameId} player={i.player} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
