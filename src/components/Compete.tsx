import { useEffect, useState } from 'react';
import { LEAGUES } from '../espn';
import { fmtAmerican, fmtPct } from '../bets';
import { fmtDate } from '../store';
import { usePro } from '../pro';
import {
  createPlayer,
  currentPlayer,
  fetchBoard,
  fetchProfile,
  overlayUrl,
  playersReady,
  profileUrl,
  removeBranding,
  signInWithCode,
  signOut,
  useMe,
  WEEK_POINTS,
  type Board,
  type Profile,
} from '../players';
import type { RecordPick } from '../server';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b className={tone}>{value}</b>
      {sub && <span className="muted sub">{sub}</span>}
    </div>
  );
}

const pts = (n: number) => Math.round(n).toLocaleString();

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The free weekly contest, everyone's verified records and the leaderboards. */
export default function Compete() {
  const me = useMe();
  if (!playersReady())
    return (
      <section>
        <div className="hero">
          <h1>Compete</h1>
        </div>
        <div className="empty">This turns on once the Birdman server is connected.</div>
      </section>
    );
  return (
    <section className="compete">
      <div className="hero">
        <p className="kicker">Free · weekly · verified</p>
        <h1>Compete</h1>
        <p className="muted">
          Every week you get {pts(WEEK_POINTS)} pretend points. Put picks on your own verified record, locked before the game starts and graded
          automatically, and climb the board. No money, just bragging rights.
        </p>
      </div>
      {me ? <MyCard name={me.name} /> : <Join />}
      <Leaderboards me={me?.name} />
      <div className="card">
        <b>How to enter a pick</b>
        <p className="muted small">
          Open <a href="#nba">Scores</a>, tap any price (or a player prop in a game's details), and choose <b>Post to my record & contest</b>. Picks lock
          the moment you post and can't be edited or deleted, just like Birdman's own record.
        </p>
      </div>
    </section>
  );
}

function Join() {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'new' | 'code'>('new');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card join">
      <div className="seg">
        <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          Pick a name
        </button>
        <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>
          I have a sign-in code
        </button>
      </div>
      {mode === 'new' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => createPlayer(name));
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player name (3–20 letters, numbers or _)" maxLength={20} required />
          <button className="btn gold" disabled={busy}>
            {busy ? 'One sec…' : 'Join the contest'}
          </button>
          <small className="muted">Your name shows on the leaderboard. No email or password needed.</small>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => signInWithCode(code));
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste your sign-in code" required />
          <button className="btn" disabled={busy}>
            Sign in
          </button>
        </form>
      )}
      {msg && <p className="warn small">{msg}</p>}
    </div>
  );
}

function MyCard({ name }: { name: string }) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pro = usePro();

  useEffect(() => {
    let live = true;
    const get = () => fetchProfile(name).then((x) => live && setP(x), (e) => live && setErr((e as Error).message));
    get();
    const t = setInterval(() => !document.hidden && get(), 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [name]);

  // Pro: keep the overlay unbranded (the server re-checks Pro each time).
  useEffect(() => {
    if (pro.pro && p?.player.branded) removeBranding().then(() => setP((x) => (x ? { ...x, player: { ...x.player, branded: false } } : x)), () => {});
  }, [pro.pro, p?.player.branded]);

  const me = currentPlayer();
  const s = p?.summary;
  const w = p?.week;
  const settled = s ? s.won + s.lost : 0;
  return (
    <>
      <div className="card mycard">
        <div className="row between">
          <b>👤 {name}</b>
          <a className="linkbtn small" href={`#player/${encodeURIComponent(name)}`}>
            Public profile
          </a>
        </div>
        {err && <p className="warn small">{err}</p>}
        {w && s && (
          <div className="stats">
            <Stat label="This week" value={`${pts(w.points)} pts`} sub={`${pts(w.available)} left to play`} tone={w.points > WEEK_POINTS ? 'pos' : w.points < WEEK_POINTS ? 'neg' : undefined} />
            <Stat label="Record" value={`${s.won}-${s.lost}${s.push ? `-${s.push}` : ''}`} sub={s.pending ? `${s.pending} pending` : undefined} />
            <Stat label="ROI" value={settled ? fmtPct(s.roi) : '—'} tone={s.roi > 0 ? 'pos' : s.roi < 0 ? 'neg' : undefined} />
            <Stat label="Beat the close" value={s.clvMeasured ? fmtPct(s.clvBeat / s.clvMeasured) : '—'} sub={s.clvMeasured ? `${s.clvBeat} of ${s.clvMeasured}` : 'after kickoffs'} />
          </div>
        )}
        {p && <PickList picks={p.picks.slice(0, 8)} />}
        <div className="row wrap">
          <button className="btn ghost sm" onClick={async () => setNote((await copy(profileUrl(name))) ? 'Profile link copied.' : profileUrl(name))}>
            Share my record
          </button>
          <button className="btn ghost sm" onClick={() => setShowCode((x) => !x)}>
            {showCode ? 'Hide sign-in code' : 'Sign-in code'}
          </button>
          <button className="btn ghost sm" onClick={() => confirm('Sign out on this device? You can sign back in with your sign-in code.') && signOut()}>
            Sign out
          </button>
        </div>
        {showCode && me && (
          <p className="small">
            Use this code to sign in on another device. Keep it private; anyone with it can post as you.
            <br />
            <code className="code">{me.token}</code>{' '}
            <button className="linkbtn small" onClick={async () => setNote((await copy(me.token)) ? 'Code copied.' : 'Copy it by hand.')}>
              Copy
            </button>
          </p>
        )}
        {note && <p className="muted small">{note}</p>}
      </div>
      <OverlayCard name={name} branded={p?.player.branded ?? true} />
    </>
  );
}

function OverlayCard({ name, branded }: { name: string; branded: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const pro = usePro();
  const url = overlayUrl(name);
  return (
    <div className="card">
      <b>🎥 Stream overlay</b>
      <p className="muted small">
        Show your open picks with live scores on stream. In OBS: Sources → + → <b>Browser</b>, paste this link, width 420, height 600. The background
        is see-through, and a banner pops up when you post a pick.
      </p>
      <p className="small">
        <code className="code">{url}</code>{' '}
        <button className="linkbtn small" onClick={async () => setNote((await copy(url)) ? 'Overlay link copied.' : 'Copy it by hand.')}>
          Copy
        </button>{' '}
        <a className="linkbtn small" href={`#overlay/${encodeURIComponent(name)}`}>
          Preview
        </a>
      </p>
      <p className="muted small">
        {branded ? (pro.pro ? 'Removing the Birdman branding…' : 'Shows a small "Birdman Picks" tag. Pro members can remove it.') : 'No branding (Pro).'}
      </p>
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}

function Leaderboards({ me }: { me?: string }) {
  const [b, setB] = useState<Board | null>(null);
  const [tab, setTab] = useState<'week' | 'all'>('week');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const get = () => fetchBoard().then((x) => live && setB(x), (e) => live && setErr((e as Error).message));
    get();
    const t = setInterval(() => !document.hidden && get(), 2 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return (
    <div className="card board">
      <div className="row between">
        <b>🏆 Leaderboard</b>
        <div className="seg">
          <button className={tab === 'week' ? 'on' : ''} onClick={() => setTab('week')}>
            This week
          </button>
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
            All time
          </button>
        </div>
      </div>
      {err && <p className="warn small">{err}</p>}
      {!b && !err && <p className="muted small">Loading…</p>}
      {b && tab === 'week' && (
        <>
          <p className="muted small">Week of {fmtDate(b.week)}. Everyone starts at {pts(WEEK_POINTS)} points; resets Monday.</p>
          {b.weekly.length ? (
            <ol className="ranks">
              {b.weekly.map((r, i) => (
                <li key={r.name} className={r.name === me ? 'me' : ''}>
                  <span className="rank">{i + 1}</span>
                  <a href={`#player/${encodeURIComponent(r.name)}`}>{r.name}</a>
                  <span className="muted small">
                    {r.won}-{r.lost} · {r.picks} pick{r.picks === 1 ? '' : 's'}
                  </span>
                  <b className={r.points > WEEK_POINTS ? 'pos' : r.points < WEEK_POINTS ? 'neg' : ''}>{pts(r.points)}</b>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">No picks yet this week. Be the first.</p>
          )}
        </>
      )}
      {b && tab === 'all' && (
        <>
          <p className="muted small">
            Ranked by how often you beat the closing line, the stat sharp bettors trust most. Needs {b.minClvPicks} picks with a measured close.
          </p>
          {b.allTime.length ? (
            <ol className="ranks">
              {b.allTime.map((r, i) => (
                <li key={r.name} className={r.name === me ? 'me' : ''}>
                  <span className="rank">{i + 1}</span>
                  <a href={`#player/${encodeURIComponent(r.name)}`}>{r.name}</a>
                  <span className="muted small">
                    {r.won}-{r.lost} · ROI {fmtPct(r.roi)}
                  </span>
                  <b>{fmtPct(r.beatPct)}</b>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Nobody has {b.minClvPicks} measured picks yet.</p>
          )}
        </>
      )}
    </div>
  );
}

function PickList({ picks }: { picks: RecordPick[] }) {
  if (!picks.length) return <p className="muted small">No picks yet.</p>;
  return (
    <ul className="plist">
      {picks.map((p) => (
        <li key={p.id} className={p.status}>
          <span className={`pill ${p.status}`}>{p.status === 'pending' ? 'Open' : p.status}</span>
          <span className="sel">
            {p.selection} <span className="muted">{fmtAmerican(p.odds)}</span>
            <small className="muted">
              {' '}
              · {LEAGUES[p.league]?.label ?? p.league} · {fmtDate(p.date)} · {Math.round(p.units)} pts
            </small>
          </span>
          {p.finalScore && <small className="muted">{p.finalScore}</small>}
        </li>
      ))}
    </ul>
  );
}

/** #player/<name>: anyone's public verified record. */
export function PlayerPage({ name }: { name: string }) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setP(null);
    setErr(null);
    fetchProfile(name).then(setP, (e) => setErr((e as Error).message));
  }, [name]);
  const s = p?.summary;
  const settled = s ? s.won + s.lost : 0;
  return (
    <section>
      <div className="hero">
        <p className="kicker">Verified record</p>
        <h1>{p?.player.name ?? name}</h1>
        {p && <p className="muted small">Playing since {new Date(p.player.since).toLocaleDateString()}. Every pick locked before its game and graded by the server.</p>}
      </div>
      {err && <div className="empty">{err}</div>}
      {!p && !err && <div className="empty">Loading…</div>}
      {p && s && (
        <>
          <div className="stats">
            <Stat label="Record" value={`${s.won}-${s.lost}${s.push ? `-${s.push}` : ''}`} sub={s.pending ? `${s.pending} pending` : undefined} />
            <Stat label="ROI" value={settled ? fmtPct(s.roi) : '—'} tone={s.roi > 0 ? 'pos' : s.roi < 0 ? 'neg' : undefined} />
            <Stat label="Beat the close" value={s.clvMeasured ? fmtPct(s.clvBeat / s.clvMeasured) : '—'} sub={s.clvMeasured ? `${s.clvBeat} of ${s.clvMeasured}` : undefined} />
            <Stat label="This week" value={`${pts(p.week.points)} pts`} />
          </div>
          <div className="card">
            <PickList picks={p.picks} />
          </div>
          <a className="btn ghost" href="#compete">
            ← Leaderboard
          </a>
        </>
      )}
    </section>
  );
}
