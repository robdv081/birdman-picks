import { useCallback, useEffect, useState } from 'react';
import { fetchScoreboard, LEAGUES, type Game, type LeagueKey } from '../espn';
import { copyText } from '../books';
import {
  createPool,
  forgetPool,
  getPool,
  joinPool,
  myPools,
  rememberPool,
  savePoolPick,
  serverReady,
  type PoolLink,
  type PoolView,
  type Standing,
} from '../server';
import { fmtDate, shiftYMD, todayYMD } from '../store';

const POOL_LEAGUES = (Object.keys(LEAGUES) as LeagueKey[]).filter((k) => LEAGUES[k].kind !== 'field');
const APP_URL = 'https://robdv081.github.io/birdman-picks/#pickem';

export default function Pickem() {
  const [pools, setPools] = useState<PoolLink[]>(myPools);
  const [active, setActive] = useState<string | null>(() => myPools()[0]?.code ?? null);
  const [mode, setMode] = useState<'view' | 'new' | 'join'>(() => (myPools().length ? 'view' : 'join'));

  const refreshList = () => setPools(myPools());
  const current = pools.find((p) => p.code === active) ?? pools[0];

  if (!serverReady())
    return (
      <section>
        <div className="hero">
          <p className="kicker">Coming soon</p>
          <h1>Pick'em with friends</h1>
        </div>
        <div className="card">
          <p>Free pick'em pools: pick winners with your friends, climb the weekly leaderboard, talk trash. This turns on once the Birdman server is connected.</p>
        </div>
      </section>
    );

  return (
    <section>
      <div className="hero">
        <p className="kicker">Free to play · bragging rights only</p>
        <h1>Pick'em</h1>
      </div>

      <div className="row poolbar">
        {pools.length > 0 && (
          <div className="chips small">
            {pools.map((p) => (
              <button
                key={p.code}
                className={`chip ${mode === 'view' && current?.code === p.code ? 'on' : ''}`}
                onClick={() => {
                  setActive(p.code);
                  setMode('view');
                }}
              >
                {p.name ?? p.code}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <button className={`btn sm ${mode === 'new' ? 'primary' : ''}`} onClick={() => setMode('new')}>
          New pool
        </button>
        <button className={`btn sm ${mode === 'join' ? 'primary' : ''}`} onClick={() => setMode('join')}>
          Join
        </button>
      </div>

      {mode === 'new' && (
        <NewPool
          onDone={(p) => {
            rememberPool(p);
            refreshList();
            setActive(p.code);
            setMode('view');
          }}
        />
      )}
      {mode === 'join' && (
        <JoinPool
          onDone={(p) => {
            rememberPool(p);
            refreshList();
            setActive(p.code);
            setMode('view');
          }}
        />
      )}
      {mode === 'view' && current && (
        <PoolScreen
          key={current.code}
          link={current}
          onMeta={(name, league) => {
            if (current.name !== name || current.league !== league) {
              rememberPool({ ...current, name, league });
              refreshList();
            }
          }}
          onLeave={() => {
            forgetPool(current.code);
            refreshList();
            setActive(null);
            setMode(myPools().length ? 'view' : 'join');
          }}
        />
      )}

      <p className="muted small center">
        Pick'em is free: no entry fees, no prizes, no money changes hands. Picks lock when each game starts, and nobody sees your pick until then.
      </p>
    </section>
  );
}

function NewPool({ onDone }: { onDone: (p: PoolLink) => void }) {
  const [name, setName] = useState('');
  const [league, setLeague] = useState<LeagueKey>('nfl');
  const [player, setPlayer] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card poolform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          const r = await createPool(name.trim(), league, player.trim());
          onDone({ code: r.code, token: r.token, name: name.trim() || "Birdman Pick'em", league });
        } catch (err) {
          setMsg((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Start a pool</h2>
      <label className="field">
        <span>Pool name</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Sunday crew" />
      </label>
      <div className="grid2">
        <label className="field">
          <span>League</span>
          <select value={league} onChange={(e) => setLeague(e.target.value as LeagueKey)}>
            {POOL_LEAGUES.map((k) => (
              <option key={k} value={k}>
                {LEAGUES[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={player} maxLength={20} onChange={(e) => setPlayer(e.target.value)} placeholder="Rob" required />
        </label>
      </div>
      {msg && <p className="warn">{msg}</p>}
      <button className="btn primary" disabled={busy || !player.trim()}>
        {busy ? 'Creating…' : 'Create pool'}
      </button>
    </form>
  );
}

function JoinPool({ onDone }: { onDone: (p: PoolLink) => void }) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('pool') ?? '');
  const [player, setPlayer] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card poolform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          const r = await joinPool(code.trim(), player.trim());
          onDone({ code: r.code, token: r.token });
        } catch (err) {
          setMsg((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Join a pool</h2>
      <p className="muted small">Get the 6-letter code from whoever started it, or start your own with New pool.</p>
      <div className="grid2">
        <label className="field">
          <span>Pool code</span>
          <input
            value={code}
            maxLength={8}
            autoCapitalize="characters"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="K7QX2M"
            required
          />
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={player} maxLength={20} onChange={(e) => setPlayer(e.target.value)} placeholder="Hin" required />
        </label>
      </div>
      {msg && <p className="warn">{msg}</p>}
      <button className="btn primary" disabled={busy || !code.trim() || !player.trim()}>
        {busy ? 'Joining…' : 'Join pool'}
      </button>
    </form>
  );
}

function PoolScreen({ link, onMeta, onLeave }: { link: PoolLink; onMeta: (name: string, league: LeagueKey) => void; onLeave: () => void }) {
  const [date, setDate] = useState(todayYMD);
  const [view, setView] = useState<PoolView | null>(null);
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [board, setBoard] = useState<'week' | 'all'>('week');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await getPool(link, date);
      setView(v);
      setError(null);
      onMeta(v.pool.name, v.pool.league);
      setGames(await fetchScoreboard(v.pool.league, date).then((g) => g.sort((a, b) => a.start.localeCompare(b.start))));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [link, date]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setGames(null);
    load();
    const t = setInterval(() => !document.hidden && load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const pick = async (g: Game, side: string) => {
    setSaving(g.id);
    try {
      await savePoolPick(link, g.id, date, side);
      setView((v) => (v ? { ...v, mine: { ...v.mine, [g.id]: { side, result: null } } } : v));
    } catch (e) {
      alert((e as Error).message);
      load();
    } finally {
      setSaving(null);
    }
  };

  const invite = async () => {
    const text = `Join my Birdman Picks pick'em "${view?.pool.name}" — code ${link.code}\n${APP_URL.replace('#pickem', `?pool=${link.code}#pickem`)}`;
    setCopied(await copyText(text));
    setTimeout(() => setCopied(false), 2500);
  };

  if (error && !view)
    return (
      <div className="empty">
        Couldn't open this pool: {error}{' '}
        <button className="linkbtn" onClick={onLeave}>
          Remove it from this phone
        </button>
      </div>
    );
  if (!view) return <div className="empty">Loading pool…</div>;

  const threeWay = !!LEAGUES[view.pool.league].threeWay;
  const madeToday = Object.keys(view.mine).length;
  const open = games?.filter((g) => g.state === 'pre').length ?? 0;

  return (
    <>
      <div className="card poolhead">
        <div className="row between">
          <div>
            <h2>{view.pool.name}</h2>
            <small className="muted">
              {LEAGUES[view.pool.league].label} · code <b className="code">{view.pool.code}</b> · you're {view.me}
            </small>
          </div>
          <button className="btn sm" onClick={invite}>
            {copied ? 'Copied ✓' : 'Invite friends'}
          </button>
        </div>
      </div>

      <div className="pickemgrid">
        <div>
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
          </div>
          {games == null && <div className="empty">Loading games…</div>}
          {games?.length === 0 && <div className="empty">No {LEAGUES[view.pool.league].label} games on {fmtDate(date)}. Try another day.</div>}
          {games && games.length > 0 && (
            <p className="muted small">
              {madeToday} of {games.length} picked{open ? ` · ${open} still open` : ''}
            </p>
          )}
          <ul className="pegames">
            {games?.map((g) => {
              const mine = view.mine[g.id];
              const locked = g.state !== 'pre';
              const others = view.revealed[g.id] ?? [];
              const sideBtn = (side: string, label: string) => {
                const chosen = mine?.side === side;
                const mark = chosen && mine?.result === 'right' ? ' ✓' : chosen && mine?.result === 'wrong' ? ' ✗' : '';
                const count = locked ? others.filter((o) => o.side === side).length : 0;
                return (
                  <button
                    className={`pebtn ${chosen ? 'on' : ''} ${chosen && mine?.result ? mine.result : ''}`}
                    disabled={locked || saving === g.id}
                    aria-pressed={chosen}
                    onClick={() => pick(g, side)}
                  >
                    <b>
                      {label}
                      {mark}
                    </b>
                    {locked && <small>{count} picked</small>}
                  </button>
                );
              };
              return (
                <li key={g.id} className={`card pegame ${g.state}`}>
                  <div className="row between">
                    <small className={`state ${g.state}`}>
                      {g.state === 'pre' ? new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : g.detail}
                    </small>
                    {g.state !== 'pre' && (
                      <small className="muted">
                        {g.away.abbr} {g.away.score ?? ''} – {g.home.abbr} {g.home.score ?? ''}
                      </small>
                    )}
                  </div>
                  <div className={`pesides ${threeWay ? 'three' : ''}`}>
                    {sideBtn('away', LEAGUES[g.league].kind === 'versus' ? g.away.name : g.away.abbr)}
                    {threeWay && sideBtn('draw', 'Draw')}
                    {sideBtn('home', LEAGUES[g.league].kind === 'versus' ? g.home.name : g.home.abbr)}
                  </div>
                  {locked && others.length > 0 && (
                    <small className="muted">{others.map((o) => `${o.name}: ${o.label}`).join(' · ')}</small>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="card board">
          <div className="row between">
            <h2>Leaderboard</h2>
            <div className="seg">
              <button className={board === 'week' ? 'on' : ''} onClick={() => setBoard('week')}>
                This week
              </button>
              <button className={board === 'all' ? 'on' : ''} onClick={() => setBoard('all')}>
                All time
              </button>
            </div>
          </div>
          <Leaderboard rows={view.standings} by={board} />
          <small className="muted">Week runs Monday to Sunday. One point per correct pick; ties in the game don't count.</small>
          <button
            className="linkbtn"
            onClick={() => confirm(`Leave "${view.pool.name}" on this phone? You'd need the code and a new name to rejoin.`) && onLeave()}
          >
            Remove pool from this phone
          </button>
        </div>
      </div>
    </>
  );
}

function Leaderboard({ rows, by }: { rows: Standing[]; by: 'week' | 'all' }) {
  const sorted = [...rows].sort((a, b) => b[by].right - a[by].right || a[by].wrong - b[by].wrong || a.name.localeCompare(b.name));
  let rank = 0;
  let prev = '';
  return (
    <ol className="lboard">
      {sorted.map((r, i) => {
        const key = `${r[by].right}|${r[by].wrong}`;
        if (key !== prev) rank = i + 1;
        prev = key;
        const n = r[by].right + r[by].wrong;
        return (
          <li key={r.name} className={r.me ? 'me' : ''}>
            <span className="rank">{rank}</span>
            <span className="who">{r.name}</span>
            <span className="muted small">{n ? `${Math.round((r[by].right / n) * 100)}%` : ''}</span>
            <b>
              {r[by].right}-{r[by].wrong}
            </b>
          </li>
        );
      })}
    </ol>
  );
}
