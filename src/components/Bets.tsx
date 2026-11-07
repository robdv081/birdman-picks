import { useMemo, useRef, useState } from 'react';
import SendToBook from './SendToBook';
import { LEAGUES } from '../espn';
import {
  fmtAmerican,
  fmtMoney,
  fmtPct,
  fmtUnits,
  isGradable,
  MARKET_LABEL,
  profit,
  summarize,
  type Bet,
  type BetStatus,
} from '../bets';
import type { Lineup } from '../fantasy';
import { fmtDate, useStored } from '../store';
import LiveSweat from './LiveSweat';
import ReportCard from './ReportCard';
import AlertsToggle from './AlertsToggle';
import { HELPLINE, stakedThisWeek } from '../guard';
import { ProCard, ProGate } from './Pro';

export interface Settings {
  unitSize: number; // dollars per unit; 0 = not set
  startBankroll?: number;
  /** Most units to put in play in a week (Monday to Sunday); 0 or missing = no limit. */
  weeklyLimit?: number;
}

interface Props {
  bets: Bet[];
  setBets: (fn: (prev: Bet[]) => Bet[]) => void;
  lineups: Lineup[];
  setLineups: (v: Lineup[]) => void;
  onEdit: (b?: Bet) => void;
}

type Filter = 'all' | 'pending' | 'settled';
type GroupBy = 'league' | 'market' | 'book' | 'month';

const GROUP_LABEL: Record<GroupBy, string> = { league: 'League', market: 'Bet type', book: 'Sportsbook', month: 'Month' };

function groupKey(b: Bet, by: GroupBy): string {
  switch (by) {
    case 'league': {
      const leagues = new Set((b.legs ?? [b]).map((s) => s.league).filter(Boolean));
      if (leagues.size === 1) return LEAGUES[[...leagues][0]!].label;
      return leagues.size > 1 ? 'Multi-sport' : 'Not linked';
    }
    case 'market':
      return MARKET_LABEL[b.market];
    case 'book':
      return b.book?.trim() || 'No book';
    case 'month':
      return new Date(b.date + 'T12:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
}

export default function Bets({ bets, setBets, lineups, setLineups, onEdit }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sendId, setSendId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('league');
  const [settings, setSettings] = useStored<Settings>('bp.settings', () => ({ unitSize: 0 }));
  const fileRef = useRef<HTMLInputElement>(null);
  const s = summarize(bets);
  const unit = settings.unitSize;
  const usd = (u: number, sign = true) => (unit > 0 ? fmtMoney(u * unit, sign) : null);

  const sorted = useMemo(
    () => [...bets].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [bets]
  );
  const shown = sorted.filter((b) => (filter === 'all' ? true : filter === 'pending' ? b.status === 'pending' : b.status !== 'pending'));

  const breakdown = useMemo(() => {
    const groups = new Map<string, Bet[]>();
    for (const b of bets) {
      if (b.status === 'pending' || b.status === 'void') continue;
      const k = groupKey(b, groupBy);
      groups.set(k, [...(groups.get(k) ?? []), b]);
    }
    return [...groups.entries()].map(([k, list]) => ({ k, ...summarize(list) })).sort((a, b) => b.profit - a.profit);
  }, [bets, groupBy]);

  const settle = (id: string, status: BetStatus) => setBets((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b)));

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ version: 2, bets, lineups, settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `birdman-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importData = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.bets) || !Array.isArray(data.lineups)) throw new Error('Not a Birdman backup');
      if (!confirm(`Replace current data with ${data.bets.length} bets and ${data.lineups.length} lineups from this backup?`)) return;
      setBets(() => data.bets);
      setLineups(data.lineups);
      if (data.settings) setSettings(data.settings);
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  };

  const numOrUndef = (v: string) => {
    const n = parseFloat(v.replace(/[$,]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  return (
    <section>
      <div className="pagehead">
        <h1>My Bets</h1>
        <button className="btn primary" onClick={() => onEdit()}>
          + Add bet
        </button>
      </div>

      <AlertsToggle />
      <LiveSweat bets={bets} />

      <div className="stats">
        <Stat label="Record" value={`${s.won}-${s.lost}${s.push ? `-${s.push}` : ''}`} />
        <Stat
          label="Profit"
          value={fmtUnits(s.profit)}
          sub={usd(s.profit)}
          tone={s.profit > 0 ? 'pos' : s.profit < 0 ? 'neg' : undefined}
        />
        <Stat label="Yield" value={s.staked ? fmtPct(s.yield) : '—'} tone={s.yield > 0 ? 'pos' : s.yield < 0 ? 'neg' : undefined} />
        {unit > 0 && settings.startBankroll != null ? (
          <Stat
            label="Bankroll"
            value={fmtMoney(settings.startBankroll + s.profit * unit)}
            sub={`started ${fmtMoney(settings.startBankroll)}`}
          />
        ) : (
          <Stat label="Pending" value={String(s.pending)} />
        )}
      </div>

      <div className="card bankroll">
        <label className="field">
          <span>1 unit =</span>
          <input
            inputMode="decimal"
            placeholder="$ amount"
            defaultValue={unit || ''}
            onBlur={(e) => setSettings((p) => ({ ...p, unitSize: numOrUndef(e.target.value) ?? 0 }))}
          />
        </label>
        <label className="field">
          <span>Starting bankroll</span>
          <input
            inputMode="decimal"
            placeholder="$ amount"
            defaultValue={settings.startBankroll ?? ''}
            onBlur={(e) => setSettings((p) => ({ ...p, startBankroll: numOrUndef(e.target.value) }))}
          />
        </label>
        <p className="muted">
          {unit > 0
            ? `Profits shown in dollars at ${fmtMoney(unit)} per unit.`
            : 'Set a unit size to see profit in dollars.'}
        </p>
      </div>

      <ProCard />

      <WeeklyLimit bets={bets} settings={settings} setSettings={setSettings} unit={unit} parse={numOrUndef} />

      <ProfitChart bets={bets} unit={unit} />

      {breakdown.length > 0 && (
        <div className="card breakdown">
          <div className="row between">
            <b>Results by</b>
            <div className="seg">
              {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
                <button key={g} className={g === groupBy ? 'on' : ''} onClick={() => setGroupBy(g)}>
                  {GROUP_LABEL[g]}
                </button>
              ))}
            </div>
          </div>
          <div className="tablewrap">
            <table className="bk">
              <thead>
                <tr>
                  <th>{GROUP_LABEL[groupBy]}</th>
                  <th>W-L-P</th>
                  <th>Profit</th>
                  {unit > 0 && <th>$</th>}
                  <th>Yield</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((r) => (
                  <tr key={r.k}>
                    <td>{r.k}</td>
                    <td>
                      {r.won}-{r.lost}-{r.push}
                    </td>
                    <td className={r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : ''}>{fmtUnits(r.profit)}</td>
                    {unit > 0 && <td className={r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : ''}>{usd(r.profit)}</td>}
                    <td>{r.staked ? fmtPct(r.yield) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ProGate feature="Report card" blurb="Closing line value, how your parlays die, and which bet types make or cost you money.">
        <ReportCard bets={bets} />
      </ProGate>

      <div className="chips small">
        {(['all', 'pending', 'settled'] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {shown.length === 0 && (
        <div className="empty">
          No bets here yet. Tap any price on the Scores tab to track it, or use <b>+ Add bet</b>.
        </div>
      )}

      <ul className="betlist">
        {shown.map((b) => {
          const p = profit(b);
          const auto = b.legs ? b.legs.some(isGradable) : isGradable(b);
          return (
            <li key={b.id} className={`bet ${b.status} ${sendId === b.id ? 'sending' : ''}`}>
              <button className="betmain" onClick={() => onEdit(b)}>
                <span className="betsel">
                  <b>{b.selection}</b>
                  <small>
                    {[fmtDate(b.date), b.league && LEAGUES[b.league].label, b.matchup, MARKET_LABEL[b.market], b.book]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  {b.finalScore && <small>Final: {b.finalScore}</small>}
                  {b.legs && (
                    <span className="legdots">
                      {b.legs.map((l, i) => (
                        <small key={i} className={l.status}>
                          <i />
                          {l.selection}
                          {l.finalScore && <em> · {l.finalScore}</em>}
                        </small>
                      ))}
                    </span>
                  )}
                  {b.notes && <small className="notes">{b.notes}</small>}
                </span>
                <span className="betnum">
                  <b>{fmtAmerican(b.settledOdds ?? b.odds)}</b>
                  <small>
                    {b.stake}u{unit > 0 && ` · ${fmtMoney(b.stake * unit)}`}
                  </small>
                </span>
              </button>
              <div className="betside">
                {b.status === 'pending' && (
                  <button className="linkbtn sendto" onClick={() => setSendId(sendId === b.id ? null : b.id)} aria-expanded={sendId === b.id}>
                    {sendId === b.id ? 'Close' : 'Bet it →'}
                  </button>
                )}
                {b.status === 'pending' ? (
                  auto ? (
                    <span className="pill pending" title="Settles itself when the game goes final">
                      Auto-grade
                    </span>
                  ) : (
                    <span className="quick">
                      <button onClick={() => settle(b.id, 'won')} title="Mark won">W</button>
                      <button onClick={() => settle(b.id, 'lost')} title="Mark lost">L</button>
                      <button onClick={() => settle(b.id, 'push')} title="Mark push">P</button>
                    </span>
                  )
                ) : (
                  <>
                    <span className={`pill ${b.status}`}>{b.status}</span>
                    <span className={p > 0 ? 'pos' : p < 0 ? 'neg' : 'muted'}>{fmtUnits(p)}</span>
                    {usd(p) && <small className="muted">{usd(p)}</small>}
                  </>
                )}
              </div>
              {sendId === b.id && (
                <div className="betsend">
                  <SendToBook picks={b.legs ?? [b]} title={b.legs ? b.selection : undefined} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="card backup">
        <div>
          <b>Your data</b>
          <p className="muted">Bets, lineups and settings are saved on this device. Export a backup to move them or keep a copy.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={exportData}>
            Export backup
          </button>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importData(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b className={tone}>{value}</b>
      {sub && <span className="muted sub">{sub}</span>}
    </div>
  );
}

function ProfitChart({ bets, unit }: { bets: Bet[]; unit: number }) {
  const settled = bets
    .filter((b) => b.status !== 'pending' && b.status !== 'void')
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  if (settled.length < 2) return null;

  let run = 0;
  const pts = [0, ...settled.map((b) => (run += profit(b)))];
  const W = 600;
  const H = 120;
  const min = Math.min(0, ...pts);
  const max = Math.max(0, ...pts);
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - 8 - ((v - min) / span) * (H - 16);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const up = run >= 0;

  return (
    <div className="card chart">
      <small className="muted">
        Running profit · {settled.length} settled bets · {fmtUnits(run)}
        {unit > 0 && ` (${fmtMoney(run * unit, true)})`}
      </small>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Running profit ${fmtUnits(run)}`}>
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="zero" />
        <path d={d} className={up ? 'line pos' : 'line neg'} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function WeeklyLimit({
  bets,
  settings,
  setSettings,
  unit,
  parse,
}: {
  bets: Bet[];
  settings: Settings;
  setSettings: (fn: (p: Settings) => Settings) => void;
  unit: number;
  parse: (v: string) => number | undefined;
}) {
  const limit = settings.weeklyLimit ?? 0;
  const used = stakedThisWeek(bets);
  const pct = limit ? Math.min(1, used / limit) : 0;
  const tone = !limit ? '' : used > limit ? 'neg' : pct >= 0.8 ? 'warnc' : 'pos';
  const money = (u: number) => (unit > 0 ? ` (${fmtMoney(u * unit)})` : '');
  return (
    <div className="card guard">
      <div className="row between">
        <b>Weekly limit</b>
        <label className="field inline">
          <input
            inputMode="decimal"
            placeholder="units"
            aria-label="Weekly limit in units"
            defaultValue={limit || ''}
            onBlur={(e) => setSettings((p) => ({ ...p, weeklyLimit: parse(e.target.value) ?? 0 }))}
          />
          <span className="muted small">units / week</span>
        </label>
      </div>
      {limit > 0 ? (
        <>
          <div className={`meter ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
            <i style={{ width: `${pct * 100}%` }} />
          </div>
          <p className="small">
            <b className={tone}>{used.toFixed(1)}u</b> of {limit}u in play since Monday{money(used)}.{' '}
            {used > limit ? 'You\u2019re over your limit this week.' : `${(limit - used).toFixed(1)}u left${money(limit - used)}.`}
          </p>
        </>
      ) : (
        <p className="muted small">Set a weekly limit and the app warns you before a bet takes you past it. Resets every Monday.</p>
      )}
      <p className="muted small">
        Betting should stay fun. If it isn't, call {HELPLINE} for free, confidential help, any time.
      </p>
    </div>
  );
}
