import { useState } from 'react';
import { newId } from '../bets';
import { fetchScoreboard, fetchSummary, LEAGUE_KEYS, LEAGUES } from '../espn';
import { canScore, fantasyPoints } from '../stats';
import { emptySlots, templateFor, TEMPLATES, totals, type Lineup, type Slot } from '../fantasy';
import { fmtDate, todayYMD } from '../store';
import Optimizer from './Optimizer';

interface Props {
  lineups: Lineup[];
  setLineups: (fn: (prev: Lineup[]) => Lineup[]) => void;
}

const money = (n: number) => `$${n.toLocaleString()}`;

export default function Fantasy({ lineups, setLineups }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [newTpl, setNewTpl] = useState(TEMPLATES[0].id);

  const sorted = [...lineups].sort((a, b) => b.date.localeCompare(a.date));
  const update = (id: string, patch: Partial<Lineup>) => setLineups((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const create = () => {
    const t = templateFor(newTpl);
    const l: Lineup = { id: newId(), title: `${t.label} lineup`, date: todayYMD(), templateId: t.id, cap: t.cap, slots: emptySlots(t) };
    setLineups((prev) => [l, ...prev]);
    setOpenId(l.id);
  };

  const duplicate = (l: Lineup) => {
    const copy: Lineup = { ...l, id: newId(), title: `${l.title} (copy)`, date: todayYMD(), winnings: null, slots: l.slots.map((s) => ({ ...s, points: null })) };
    setLineups((prev) => [copy, ...prev]);
    setOpenId(copy.id);
  };

  return (
    <section>
      <div className="pagehead">
        <h1>Fantasy Lineups</h1>
        <div className="row">
          <select value={newTpl} onChange={(e) => setNewTpl(e.target.value)} aria-label="Contest format">
            {LEAGUE_KEYS.filter((k) => TEMPLATES.some((t) => t.league === k)).map((k) => (
              <optgroup key={k} label={LEAGUES[k].label}>
                {TEMPLATES.filter((t) => t.league === k).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {money(t.cap)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="btn primary" onClick={create}>
            + New lineup
          </button>
        </div>
      </div>

      <Optimizer
        onSave={(l) => {
          setLineups((prev) => [l, ...prev]);
          setOpenId(l.id);
        }}
      />

      {sorted.length === 0 && <div className="empty">No lineups yet. Pick a contest format and start one.</div>}

      <div className="lineups">
        {sorted.map((l) => {
          const t = totals(l);
          const open = openId === l.id;
          return (
            <article key={l.id} className={`card lineup ${open ? 'open' : ''}`}>
              <button className="lhead" onClick={() => setOpenId(open ? null : l.id)} aria-expanded={open}>
                <span>
                  <b>{l.title}</b>
                  <small>
                    {fmtDate(l.date)} · {templateFor(l.templateId).label}
                  </small>
                </span>
                <span className="lsum">
                  <span className={t.remaining < 0 ? 'neg' : ''}>
                    {money(t.salary)} / {money(l.cap)}
                  </span>
                  {t.scored && <b>{t.points.toFixed(1)} pts</b>}
                </span>
              </button>
              {open ? (
                <Editor lineup={l} onChange={(p) => update(l.id, p)} />
              ) : (
                <p className="players">{l.slots.filter((s) => s.player).map((s) => s.player).join(' · ') || 'Empty lineup'}</p>
              )}
              {open && (
                <div className="actions">
                  <button
                    className="btn danger"
                    onClick={() => confirm(`Delete "${l.title}"?`) && setLineups((prev) => prev.filter((x) => x.id !== l.id))}
                  >
                    Delete
                  </button>
                  <span className="spacer" />
                  <button className="btn ghost" onClick={() => duplicate(l)}>
                    Duplicate
                  </button>
                  <button className="btn" onClick={() => setOpenId(null)}>
                    Done
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function Editor({ lineup: l, onChange }: { lineup: Lineup; onChange: (p: Partial<Lineup>) => void }) {
  const t = totals(l);
  const setSlot = (i: number, patch: Partial<Slot>) => onChange({ slots: l.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const [filling, setFilling] = useState(false);
  const [fillMsg, setFillMsg] = useState<string | null>(null);

  const fillPoints = async () => {
    setFilling(true);
    setFillMsg(null);
    try {
      const league = templateFor(l.templateId).league;
      const games = (await fetchScoreboard(league, l.date)).filter((g) => g.state !== 'pre');
      if (!games.length) {
        setFillMsg(`No ${LEAGUES[league].label} games have started on ${fmtDate(l.date)} yet.`);
        return;
      }
      const summaries = await Promise.all(games.map((g) => fetchSummary(league, g.id)));
      const missing: string[] = [];
      const slots = l.slots.map((s) => {
        if (!s.player.trim()) return s;
        const pts = fantasyPoints(summaries, s.player, l.templateId);
        if (pts == null) {
          missing.push(s.player);
          return s;
        }
        return { ...s, points: pts };
      });
      onChange({ slots });
      const live = games.some((g) => g.state === 'in');
      setFillMsg(
        [
          `Filled ${slots.filter((s) => s.player).length - missing.length} players${live ? ' (games still live, so run it again later)' : ''}.`,
          missing.length ? `Not found: ${missing.join(', ')}. Check the spelling or enter points by hand.` : '',
        ].join(' ')
      );
    } catch (e) {
      setFillMsg(`Couldn't load box scores: ${(e as Error).message}`);
    } finally {
      setFilling(false);
    }
  };

  return (
    <div className="editor">
      <div className="grid3">
        <label className="field">
          <span>Name</span>
          <input value={l.title} onChange={(e) => onChange({ title: e.target.value })} />
        </label>
        <label className="field">
          <span>Slate date</span>
          <input type="date" value={l.date} onChange={(e) => onChange({ date: e.target.value })} />
        </label>
        <label className="field">
          <span>Salary cap</span>
          <input inputMode="numeric" value={l.cap} onChange={(e) => onChange({ cap: num(e.target.value) ?? 0 })} />
        </label>
      </div>

      <div className="tablewrap">
        <table className="slots">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Player</th>
              <th>Team / game</th>
              <th className="r">Salary</th>
              <th className="r">FPts</th>
            </tr>
          </thead>
          <tbody>
            {l.slots.map((s, i) => (
              <tr key={i}>
                <td className="slot">{s.slot}</td>
                <td>
                  <input value={s.player} onChange={(e) => setSlot(i, { player: e.target.value })} placeholder="Player" aria-label={`${s.slot} player`} />
                </td>
                <td>
                  <input value={s.team} onChange={(e) => setSlot(i, { team: e.target.value })} placeholder="Team" aria-label={`${s.slot} team`} />
                </td>
                <td className="r">
                  <input
                    className="r"
                    inputMode="numeric"
                    value={s.salary ?? ''}
                    onChange={(e) => setSlot(i, { salary: num(e.target.value) })}
                    placeholder="0"
                    aria-label={`${s.slot} salary`}
                  />
                </td>
                <td className="r">
                  <input
                    className="r"
                    inputMode="decimal"
                    value={s.points ?? ''}
                    onChange={(e) => setSlot(i, { points: num(e.target.value) })}
                    placeholder="—"
                    aria-label={`${s.slot} fantasy points`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <span className={t.remaining < 0 ? 'neg' : t.remaining === 0 ? 'pos' : ''}>
                  {t.remaining < 0 ? `${money(-t.remaining)} over the cap` : `${money(t.remaining)} left`}
                </span>
                {l.slots.length > 0 && (
                  <span className="muted"> · avg {money(Math.round(t.remaining / Math.max(1, l.slots.filter((s) => !s.salary).length)))} per open slot</span>
                )}
              </td>
              <td className="r">{money(t.salary)}</td>
              <td className="r">{t.scored ? t.points.toFixed(1) : '—'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="row">
        {canScore(l.templateId) && (
          <button className="btn" onClick={fillPoints} disabled={filling}>
            {filling ? 'Loading box scores…' : 'Fill points from box scores'}
          </button>
        )}
        {t.scored && <span className="muted">{t.perK.toFixed(2)} pts per $1K salary</span>}
      </div>
      {fillMsg && <p className="muted small">{fillMsg}</p>}

      <div className="grid3">
        <label className="field">
          <span>Entry fee ($)</span>
          <input inputMode="decimal" value={l.entryFee ?? ''} onChange={(e) => onChange({ entryFee: num(e.target.value) })} />
        </label>
        <label className="field">
          <span>Winnings ($)</span>
          <input inputMode="decimal" value={l.winnings ?? ''} onChange={(e) => onChange({ winnings: num(e.target.value) })} />
        </label>
        <div className="field">
          <span>Net</span>
          <b className="net">
            {l.entryFee != null && l.winnings != null ? (
              <span className={l.winnings - l.entryFee >= 0 ? 'pos' : 'neg'}>{money(l.winnings - l.entryFee)}</span>
            ) : (
              <span className="muted">—</span>
            )}
          </b>
        </div>
      </div>

      <label className="field">
        <span>Notes</span>
        <textarea rows={3} value={l.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value })} placeholder="Stacks, injury checks, lessons learned…" />
      </label>
    </div>
  );
}
