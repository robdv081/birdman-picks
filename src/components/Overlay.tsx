import { useEffect, useRef, useState } from 'react';
import { fetchScoreboard, LEAGUES, type Game, type LeagueKey } from '../espn';
import { fmtAmerican } from '../bets';
import { fetchProfile } from '../players';
import { fetchRecord, type RecordPick } from '../server';

/**
 * #overlay/<name> (or #overlay/birdman): a see-through panel for OBS. Open picks with live scores, the last few
 * results, and a banner when a new pick posts. Refreshes picks every 30 seconds and scores every 20.
 */
export default function Overlay({ name }: { name: string }) {
  const birdman = name.toLowerCase() === 'birdman';
  const [picks, setPicks] = useState<RecordPick[] | null>(null);
  const [title, setTitle] = useState(birdman ? 'Birdman Picks' : name);
  const [sub, setSub] = useState('');
  const [branded, setBranded] = useState(true);
  const [banner, setBanner] = useState<RecordPick | null>(null);
  const [games, setGames] = useState<Map<string, Game>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    // OBS shows whatever's behind the page; make it see-through.
    const html = document.documentElement;
    const prev = [html.style.background, document.body.style.background];
    html.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.classList.add('overlay-mode');
    return () => {
      [html.style.background, document.body.style.background] = prev;
      document.body.classList.remove('overlay-mode');
    };
  }, []);

  useEffect(() => {
    let live = true;
    const get = async () => {
      try {
        let list: RecordPick[];
        if (birdman) {
          const r = await fetchRecord();
          list = r.picks;
          setSub(`${r.summary.won}-${r.summary.lost}${r.summary.push ? `-${r.summary.push}` : ''} · ${r.summary.units >= 0 ? '+' : ''}${r.summary.units.toFixed(1)}u`);
        } else {
          const p = await fetchProfile(name);
          list = p.picks;
          setTitle(p.player.name);
          setBranded(p.player.branded);
          setSub(`${p.summary.won}-${p.summary.lost} · ${Math.round(p.week.points).toLocaleString()} pts this week`);
        }
        if (!live) return;
        if (seen.current) {
          const fresh = list.find((p) => !seen.current!.has(p.id));
          if (fresh) {
            setBanner(fresh);
            setTimeout(() => live && setBanner(null), 12_000);
          }
        }
        seen.current = new Set(list.map((p) => p.id));
        setPicks(list);
        setErr(null);
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    };
    get();
    const t = setInterval(get, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [name, birdman]);

  const now = Date.now();
  const open = (picks ?? []).filter((p) => p.status === 'pending').slice(0, 5);
  const recent = (picks ?? []).filter((p) => p.status !== 'pending' && now - p.startAt < 18 * 3600_000).slice(0, 3);

  // Live scores for the open picks' games.
  const boards = [...new Set(open.filter((p) => !p.sealed && p.eventId).map((p) => `${p.league}|${p.date}`))].join(',');
  useEffect(() => {
    if (!boards) return;
    let live = true;
    const get = async () => {
      const m = new Map<string, Game>();
      for (const b of boards.split(',')) {
        const [league, date] = b.split('|');
        try {
          for (const g of await fetchScoreboard(league as LeagueKey, date)) m.set(g.id, g);
        } catch {
          /* keep going */
        }
      }
      if (live) setGames(m);
    };
    get();
    const t = setInterval(get, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [boards]);

  return (
    <div className="overlay">
      <div className="ov-head">
        <b>{title}</b>
        <small>{sub}</small>
      </div>
      {banner && (
        <div className="ov-banner">
          <small>{banner.sealed ? 'New pick locked' : 'Pick posted'}</small>
          <b>{banner.sealed ? `🔒 ${LEAGUES[banner.league]?.label ?? banner.league} · revealed at start` : `${banner.selection} ${fmtAmerican(banner.odds)}`}</b>
        </div>
      )}
      {err && !picks && <div className="ov-row">Can't load picks: {err}</div>}
      {open.map((p) => {
        const g = games.get(p.eventId);
        return (
          <div key={p.id} className="ov-row">
            <div className="ov-main">
              <b>{p.sealed ? '🔒 Locked pick' : p.selection}</b>
              <small>
                {p.sealed ? `${LEAGUES[p.league]?.label ?? p.league} · revealed at start` : `${fmtAmerican(p.odds)} · ${p.matchup}`}
              </small>
            </div>
            <div className="ov-score">{g ? scoreLine(g) : new Date(p.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
          </div>
        );
      })}
      {recent.map((p) => (
        <div key={p.id} className={`ov-row done ${p.status}`}>
          <div className="ov-main">
            <b>
              {p.status === 'won' ? '✅' : p.status === 'lost' ? '❌' : '➖'} {p.selection}
            </b>
            <small>{p.finalScore ?? p.status}</small>
          </div>
        </div>
      ))}
      {picks && !open.length && !recent.length && <div className="ov-row muted">No open picks right now.</div>}
      {(birdman || branded) && <div className="ov-brand">🐦 Birdman Picks · robdv081.github.io/birdman-picks</div>}
    </div>
  );
}

function scoreLine(g: Game) {
  const sc = `${g.away.abbr} ${g.away.score ?? 0} – ${g.home.abbr} ${g.home.score ?? 0}`;
  if (g.state === 'pre') return new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (g.state === 'post') return `Final · ${sc}`;
  return `${g.detail || 'Live'} · ${sc}`;
}
