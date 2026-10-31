import { useMemo, useRef, useState } from 'react';
import { fetchInjuries, fetchScoreboard, type Injury } from '../espn';
import { newId } from '../bets';
import { templateFor, TEMPLATES, type Lineup } from '../fantasy';
import { projectGame, type PlayerProjection } from '../market';
import { optimize, parseSalaries, projectPoints, risks, RISK_LABEL, type Optimized, type PoolPlayer, type Risk } from '../optimizer';
import { sameName } from '../stats';
import { fmtDate, shiftYMD, todayYMD } from '../store';

const NBA_TEMPLATES = TEMPLATES.filter((t) => t.league === 'nba');
const money = (n: number) => `$${n.toLocaleString()}`;
// Risks that bench a player in "avoid minutes risk" mode; questionable alone doesn't.
const ROTATION_RISKS: Risk[] = ['no-market', 'low-minutes', 'volatile'];

interface Row extends PoolPlayer {
  source: string;
}

export default function Optimizer({ onSave }: { onSave: (l: Lineup) => void }) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(NBA_TEMPLATES[0].id);
  const [date, setDate] = useState(todayYMD);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [safe, setSafe] = useState(true);
  const [result, setResult] = useState<Optimized | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tpl = templateFor(templateId);

  const salaries = useMemo(() => parseSalaries(text), [text]);

  const build = async () => {
    setError(null);
    setResult(null);
    setProgress('Loading games…');
    try {
      const games = (await fetchScoreboard('nba', date)).filter((g) => g.state === 'pre');
      if (!games.length) throw new Error(`no NBA games left to start on ${fmtDate(date)}`);
      const injuries = await fetchInjuries('nba').catch(() => ({} as Record<string, Injury[]>));
      const inList = (name: string) => salaries.some((s) => sameName(s.name, name));
      const projections: PlayerProjection[] = [];
      let done = 0;
      for (const g of games) {
        setProgress(`Projecting players from prop markets… game ${++done} of ${games.length}`);
        projections.push(...(await projectGame(g, inList)));
      }
      const injuryOf = (p: PlayerProjection) => (injuries[p.teamId] ?? []).find((i) => sameName(i.player, p.name));
      const out: Row[] = [];
      const missing: string[] = [];
      for (const s of salaries) {
        const p = projections.find((x) => sameName(x.name, s.name));
        const inj = p && injuryOf(p);
        if (!p) {
          missing.push(s.name);
          continue;
        }
        if (s.out || inj?.severity === 'out') continue;
        const src = Object.values(p.source);
        out.push({
          key: p.athleteId,
          name: p.name,
          team: p.team,
          pos: s.pos,
          salary: s.salary,
          proj: Math.round(projectPoints(p, templateId) * 10) / 10,
          risks: risks(p, inj?.severity === 'q'),
          source: src.includes('line') ? 'book line' : src.includes('ladder') ? 'prop ladder' : 'recent games',
        });
      }
      setRows(out.sort((a, b) => b.proj - a.proj));
      setUnmatched(missing);
      setLocked(new Set());
      setExcluded(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const run = () => {
    if (!rows) return;
    const pool = rows.filter(
      (r) => !excluded.has(r.key) && (locked.has(r.key) || !safe || !r.risks.some((k) => ROTATION_RISKS.includes(k)))
    );
    setResult(optimize(pool, tpl.slots, tpl.cap, locked));
    setSaved(false);
  };

  const save = () => {
    if (!result) return;
    const flagged = result.slots.filter((s) => s.player.risks.length);
    onSave({
      id: newId(),
      title: `Optimized ${tpl.label}`,
      date,
      templateId,
      cap: tpl.cap,
      slots: result.slots.map((s) => ({ slot: s.slot, player: s.player.name, team: s.player.team, salary: s.player.salary, points: null })),
      notes: [
        `Optimizer projection ${result.proj.toFixed(1)} pts from DraftKings prop markets.`,
        flagged.length ? `Flags: ${flagged.map((s) => `${s.player.name} (${s.player.risks.map((r) => RISK_LABEL[r]).join(', ')})`).join('; ')}.` : 'No rotation flags.',
      ].join(' '),
    });
    setSaved(true);
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  if (!open)
    return (
      <button className="card optcta" onClick={() => setOpen(true)}>
        <b>Lineup optimizer</b>
        <span className="muted">NBA projections built from DraftKings prop markets, then the best lineup under the cap →</span>
      </button>
    );

  return (
    <section className="card optimizer">
      <div className="row between">
        <h2>Lineup optimizer</h2>
        <button className="x" aria-label="Close optimizer" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      <p className="muted small">
        Each player's points, rebounds, assists and threes come from the sportsbook's prop lines and milestone ladders, so the
        projection is what the betting market expects. Steals, blocks and turnovers use the last 10 games.
      </p>

      <div className="grid3">
        <label className="field">
          <span>Contest</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {NBA_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} · {money(t.cap)}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Slate</span>
          <div className="row">
            <button className="btn ghost sm" aria-label="Previous day" onClick={() => setDate((d) => shiftYMD(d, -1))}>←</button>
            <b>{fmtDate(date)}</b>
            <button className="btn ghost sm" aria-label="Next day" onClick={() => setDate((d) => shiftYMD(d, 1))}>→</button>
          </div>
        </div>
      </div>

      <label className="field">
        <span>Player salaries</span>
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Paste the player list CSV from FanDuel or DraftKings, or one per line:\nLuka Doncic, PG, 11600\nAustin Reaves, SG, 8100'}
        />
      </label>
      <div className="row">
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          Upload CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
            e.target.value = '';
          }}
        />
        <span className="muted small">{salaries.length ? `${salaries.length} players read` : 'FanDuel: Lineup → Download players list'}</span>
        <span className="spacer" />
        <button className="btn primary" disabled={!salaries.length || !!progress} onClick={build}>
          {progress ? 'Projecting…' : rows ? 'Rebuild projections' : 'Build projections'}
        </button>
      </div>

      {progress && <div className="empty">{progress}</div>}
      {error && <div className="empty">Couldn't build projections: {error}</div>}

      {rows && !progress && (
        <>
          {unmatched.length > 0 && (
            <p className="muted small">
              {unmatched.length} players aren't on tonight's slate or rosters and were skipped
              {unmatched.length <= 6 ? `: ${unmatched.join(', ')}` : ''}.
            </p>
          )}
          <div className="row between">
            <label className="check">
              <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} />
              Avoid minutes risk (no props posted, low or swinging minutes)
            </label>
            <button className="btn primary" onClick={run}>
              Optimize
            </button>
          </div>

          {result === null && rows.length > 0 && <p className="muted small">Tap Optimize to build the best lineup from this pool.</p>}
          {result && (
            <div className="card optresult">
              <div className="row between">
                <div>
                  <small className="muted">Projected</small>
                  <h2>{result.proj.toFixed(1)} pts</h2>
                </div>
                <div className="pstats">
                  <span>
                    <small>Salary</small>
                    <b>{money(result.salary)}</b>
                  </span>
                  <span>
                    <small>Left</small>
                    <b>{money(tpl.cap - result.salary)}</b>
                  </span>
                </div>
              </div>
              <table className="slots ro">
                <tbody>
                  {result.slots.map((s, i) => (
                    <tr key={i}>
                      <td className="slot">{s.slot}</td>
                      <td>
                        {s.player.name}
                        {s.player.risks.map((r) => (
                          <span key={r} className="pill pending flag">{RISK_LABEL[r]}</span>
                        ))}
                      </td>
                      <td className="muted">{s.player.team}</td>
                      <td className="r">{money(s.player.salary)}</td>
                      <td className="r">{s.player.proj.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="actions">
                <button className="btn ghost" onClick={run}>
                  ↻ Re-run
                </button>
                <span className="spacer" />
                <button className="btn primary" onClick={save} disabled={saved}>
                  {saved ? 'Saved to your lineups' : 'Save to my lineups'}
                </button>
              </div>
            </div>
          )}
          {result === null && locked.size > 0 && <p className="warn small">No legal lineup fits these locks under the cap.</p>}

          <div className="tablewrap">
            <table className="box optpool">
              <thead>
                <tr>
                  <th className="pname">Player</th>
                  <th>Pos</th>
                  <th>Salary</th>
                  <th>Proj</th>
                  <th>Pts/$1K</th>
                  <th>Lock</th>
                  <th>Skip</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={excluded.has(r.key) ? 'dnp' : ''}>
                    <td className="pname">
                      {r.name} <small>{r.team}</small>
                      {r.risks.length > 0 && <small className="inj"> · {r.risks.map((k) => RISK_LABEL[k]).join(', ')}</small>}
                    </td>
                    <td>{r.pos.join('/')}</td>
                    <td>{money(r.salary)}</td>
                    <td title={`From ${r.source}`}>{r.proj.toFixed(1)}</td>
                    <td>{((r.proj / r.salary) * 1000).toFixed(2)}</td>
                    <td>
                      <input type="checkbox" aria-label={`Lock ${r.name}`} checked={locked.has(r.key)} onChange={() => toggle(locked, setLocked, r.key)} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`Skip ${r.name}`} checked={excluded.has(r.key)} onChange={() => toggle(excluded, setExcluded, r.key)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
