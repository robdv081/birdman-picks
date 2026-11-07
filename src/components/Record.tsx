import { useEffect, useMemo, useState } from 'react';
import { LEAGUES } from '../espn';
import { clv, fmtAmerican, fmtPct, fmtUnits, type Selection } from '../bets';
import {
  checkOwnerKey,
  fetchRecord,
  ownerKey,
  serverReady,
  setOwnerKey,
  verifyChain,
  type RecordPick,
  type RecordSummary,
} from '../server';
import { fmtDate } from '../store';
import ProAlerts, { FollowButton } from './ProAlerts';

type Filter = 'all' | 'pending' | 'settled';

const asSel = (p: RecordPick): Selection => ({
  date: p.date,
  selection: p.selection,
  market: p.market,
  odds: p.odds,
  side: p.side as Selection['side'],
  line: p.line ?? undefined,
  closeOdds: p.closeOdds ?? undefined,
  closeLine: p.closeLine ?? undefined,
});

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function lead(ms: number) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} hr` : `${Math.round(h / 24)} days`;
}

export default function Record() {
  const [data, setData] = useState<{ picks: RecordPick[]; summary: RecordSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; brokenAt?: number } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [owner, setOwner] = useState(!!ownerKey());

  useEffect(() => {
    if (!serverReady()) return;
    let live = true;
    const get = () =>
      fetchRecord().then(
        async (d) => {
          if (!live) return;
          setData(d);
          setError(null);
          const v = await verifyChain(d.picks);
          if (live) setChain(v);
        },
        (e) => live && setError((e as Error).message)
      );
    get();
    const t = setInterval(() => !document.hidden && get(), 2 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const shown = useMemo(
    () => (data?.picks ?? []).filter((p) => (filter === 'all' ? true : filter === 'pending' ? p.status === 'pending' : p.status !== 'pending')),
    [data, filter]
  );

  if (!serverReady())
    return (
      <section>
        <div className="hero">
          <p className="kicker">Coming soon</p>
          <h1>Birdman's verified record</h1>
        </div>
        <div className="card">
          <p>Every Birdman pick, locked before kickoff, graded automatically, and never deleted. This turns on once the Birdman server is connected.</p>
        </div>
      </section>
    );

  const s = data?.summary;
  const settled = s ? s.won + s.lost + s.push : 0;

  return (
    <section>
      <div className="hero">
        <p className="kicker">Every pick. Wins and losses.</p>
        <h1>Birdman's record</h1>
      </div>

      {error && <div className="empty">Couldn't load the record: {error}</div>}
      {!data && !error && <div className="empty">Loading the record…</div>}

      {s && (
        <>
          <div className="stats">
            <Stat label="Record" value={`${s.won}-${s.lost}${s.push ? `-${s.push}` : ''}`} sub={s.pending ? `${s.pending} pending` : undefined} />
            <Stat label="Units" value={fmtUnits(s.units)} tone={s.units > 0 ? 'pos' : s.units < 0 ? 'neg' : undefined} />
            <Stat label="ROI" value={settled ? fmtPct(s.roi) : '—'} tone={s.roi > 0 ? 'pos' : s.roi < 0 ? 'neg' : undefined} />
            <Stat
              label="Beat the close"
              value={s.clvMeasured ? fmtPct(s.clvBeat / s.clvMeasured) : '—'}
              sub={s.clvMeasured ? `${s.clvBeat} of ${s.clvMeasured}` : 'after kickoffs'}
              tone={s.clvMeasured ? (s.clvBeat / s.clvMeasured >= 0.5 ? 'pos' : 'neg') : undefined}
            />
          </div>

          <div className={`card verify ${chain && !chain.ok ? 'bad' : ''}`}>
            <b>
              {chain == null
                ? 'Checking the record on your phone…'
                : chain.ok
                  ? `✓ Verified: all ${data!.picks.length} picks intact`
                  : `⚠ Pick #${chain.brokenAt} doesn't match its fingerprint`}
            </b>
            <p className="muted small">
              Picks marked "Model pick" are found and posted automatically by the Birdman model, which compares each player's recent games and
              ESPN's power ratings with the sportsbook's price. Every pick is locked on the Birdman server before the game starts, stamped with the server's clock, and graded automatically from ESPN's
              final scores. There's no edit or delete button. Each pick carries a fingerprint of itself and the pick before it, and your phone just
              re-checked every one, so a changed or missing pick would show up here.
            </p>
            <p className="muted small">
              "Beat the close" is how often Birdman got a better price than DraftKings' final line before kickoff. It's the stat sharp bettors trust
              most, because it shows real edge even in a losing week.
            </p>
          </div>

          <ProAlerts />

          <div className="row between recordbar">
            <div className="seg">
              {(['all', 'pending', 'settled'] as Filter[]).map((f) => (
                <button key={f} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {!shown.length && <div className="empty">{data!.picks.length ? 'Nothing here.' : 'No picks posted yet. The first one shows up here.'}</div>}
          <ul className="recordlist">
            {shown.map((p) => (
              <PickCard key={p.id} p={p} />
            ))}
          </ul>
        </>
      )}

      <OwnerBox owner={owner} setOwner={setOwner} />
    </section>
  );
}

function PickCard({ p }: { p: RecordPick }) {
  const c = clv(asSel(p));
  return (
    <li className={`card rpick ${p.status}`}>
      <div className="row between">
        <div className="rmain">
          <b>{p.selection}</b>
          <small className="muted">
            #{p.seq} · {LEAGUES[p.league]?.label ?? p.league} · {p.matchup} · {fmtDate(p.date)}
            {p.author === 'model' && <span className="pill model">Model pick</span>}
          </small>
        </div>
        <div className="rside">
          <b>{fmtAmerican(p.odds)}</b>
          <small className="muted">{p.units}u</small>
        </div>
      </div>
      {p.reason && (
        <p className="why">
          <span className="muted small">{p.author === 'model' ? 'Why the model likes it' : 'Why I like it'}</span>
          {p.reason}
        </p>
      )}
      <div className="row rfoot">
        <span className={`pill ${p.status}`}>{p.status === 'pending' ? 'Pending' : p.status}</span>
        {p.finalScore && <small>{p.finalScore}</small>}
        {c && (
          <span className={`pill ${c.beat ? 'won' : 'lost'}`} title="Closing line value">
            {c.beat ? 'Beat close' : 'Missed close'} {fmtAmerican(p.closeOdds ?? undefined)}
            {p.closeLine != null && p.line != null && p.closeLine !== p.line ? ` @ ${p.closeLine}` : ''}
          </span>
        )}
        <span className="spacer" />
        {p.status === 'pending' && p.startAt > Date.now() && <FollowButton pickId={p.id} />}
        <small className="muted" title={new Date(p.createdAt).toISOString()}>
          Locked {when(p.createdAt)} · {lead(p.startAt - p.createdAt)} before start
        </small>
      </div>
    </li>
  );
}

function OwnerBox({ owner, setOwner }: { owner: boolean; setOwner: (b: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  if (owner)
    return (
      <div className="card owner">
        <p className="small">
          <b>You're signed in as the owner.</b> To post a pick, tap a price on the Scores tab (or add a prop from a game's details) and choose "Post to my
          record". Picks lock at kickoff and can't be edited afterward, so double-check the price first.
        </p>
        <button
          className="btn ghost sm"
          onClick={() => {
            setOwnerKey('');
            setOwner(false);
          }}
        >
          Sign out
        </button>
      </div>
    );

  return (
    <div className="ownerlink">
      {!open ? (
        <button className="linkbtn" onClick={() => setOpen(true)}>
          Owner sign-in
        </button>
      ) : (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg('Checking…');
            try {
              await checkOwnerKey(key.trim());
              setOwnerKey(key.trim());
              setOwner(true);
              setMsg(null);
            } catch (err) {
              setMsg((err as Error).message);
            }
          }}
        >
          <input type="password" autoComplete="current-password" placeholder="Owner key" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn sm">Sign in</button>
          {msg && <small className="muted">{msg}</small>}
        </form>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b className={tone}>{value}</b>
      {sub && <span className="muted sub">{sub}</span>}
    </div>
  );
}
