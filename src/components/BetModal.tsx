import { useEffect, useState } from 'react';
import {
  breakEven,
  fmtMoney,
  fmtPct,
  MARKET_LABEL,
  newId,
  propLabel,
  toDecimal,
  type Bet,
  type BetSide,
  type BetStatus,
  type Leg,
  type Market,
} from '../bets';
import { PROP_STATS } from '../stats';
import { load, todayYMD } from '../store';
import type { Settings } from './Bets';
import SendToBook from './SendToBook';

interface Props {
  draft: Partial<Bet>;
  slipCount: number;
  onSave: (b: Bet) => void;
  onAddLeg: (l: Leg) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const STATUSES: BetStatus[] = ['pending', 'won', 'lost', 'push', 'void'];

export default function BetModal({ draft, slipCount, onSave, onAddLeg, onDelete, onClose }: Props) {
  const editing = !!draft.id;
  const linked = !!draft.eventId;
  const isParlay = !!draft.legs;
  const [selection, setSelection] = useState(draft.selection ?? '');
  const [market, setMarket] = useState<Market>(draft.market ?? 'other');
  const [odds, setOdds] = useState(String(draft.odds ?? -110));
  const [stake, setStake] = useState(String(draft.stake ?? 1));
  const [book, setBook] = useState(draft.book ?? '');
  const [date, setDate] = useState(draft.date ?? todayYMD());
  const [notes, setNotes] = useState(draft.notes ?? '');
  const [status, setStatus] = useState<BetStatus>(draft.status ?? 'pending');
  // Linked player props
  const propStats = (draft.league && PROP_STATS[draft.league]) || [];
  const [player, setPlayer] = useState(draft.player ?? '');
  const [stat, setStat] = useState(draft.stat ?? propStats[0]?.key ?? '');
  const [side, setSide] = useState<BetSide>(draft.side ?? 'over');
  const [line, setLine] = useState(draft.line != null ? String(draft.line) : '');
  const unit = load<Settings>('bp.settings', { unitSize: 0 }).unitSize;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const linkedProp = linked && market === 'prop';
  const lineNum = line.trim() ? Number(line) : NaN;
  const propOk = !linkedProp || (player.trim() && stat && Number.isFinite(lineNum));
  const autoLabel = linkedProp ? propLabel({ league: draft.league, player: player.trim(), stat, side, line: lineNum }) : '';
  const label = selection.trim() || autoLabel;

  const a = Number(odds.trim());
  const oddsOk = Number.isInteger(a) && Math.abs(a) >= 100;
  const u = Number(stake.trim());
  const stakeOk = Number.isFinite(u) && u > 0;
  const valid = !!label && oddsOk && propOk;

  const selectionFields = () => ({
    ...(linkedProp ? { player: player.trim(), stat, side, line: lineNum } : {}),
    selection: label,
    market,
    odds: a,
    date,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !stakeOk) return;
    onSave({
      ...(draft as Bet),
      ...selectionFields(),
      id: draft.id ?? newId(),
      createdAt: draft.createdAt ?? new Date().toISOString(),
      stake: u,
      book: book.trim() || undefined,
      notes: notes.trim() || undefined,
      status,
    });
  };

  const addLeg = () => {
    if (!valid) return;
    const { league, eventId, matchup, side: s, line: l, dkLink } = draft;
    onAddLeg({ league, eventId, matchup, side: s, line: l, dkLink, ...selectionFields(), status: 'pending' });
  };

  return (
    <div className="scrim" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{editing ? (isParlay ? 'Edit parlay' : 'Edit bet') : linkedProp ? 'Track a player prop' : 'Track a bet'}</h2>
        {draft.matchup && <p className="muted">{draft.matchup} · graded automatically when the game goes final</p>}

        {linkedProp && (
          <>
            <label className="field">
              <span>Player</span>
              <input autoFocus={!player} value={player} onChange={(e) => setPlayer(e.target.value)} placeholder="Full name, e.g. Deni Avdija" />
            </label>
            <div className="grid3">
              <label className="field">
                <span>Stat</span>
                <select value={stat} onChange={(e) => setStat(e.target.value)}>
                  {propStats.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Over / under</span>
                <select value={side} onChange={(e) => setSide(e.target.value as BetSide)}>
                  <option value="over">Over</option>
                  <option value="under">Under</option>
                </select>
              </label>
              <label className="field">
                <span>Line</span>
                <input
                  inputMode="decimal"
                  autoFocus={!!player}
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                  placeholder="24.5"
                  aria-invalid={!!line.trim() && !Number.isFinite(lineNum)}
                />
              </label>
            </div>
          </>
        )}

        <label className="field">
          <span>Pick{linkedProp && ' (optional label)'}</span>
          <input
            autoFocus={!linkedProp}
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            placeholder={autoLabel || 'e.g. Utah +6.5'}
          />
        </label>

        {isParlay && (
          <ul className="legs">
            {draft.legs!.map((l, i) => (
              <li key={i} className={l.status}>
                <span>{l.selection}</span>
                <small>{l.finalScore ?? l.matchup}</small>
                <span className={`pill ${l.status}`}>{l.status}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="grid2">
          <label className="field">
            <span>Market</span>
            <select value={market} onChange={(e) => setMarket(e.target.value as Market)} disabled={linked || isParlay}>
              {Object.entries(MARKET_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Game date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={linked} />
          </label>
          <label className="field">
            <span>Odds (American)</span>
            <input inputMode="numeric" value={odds} onChange={(e) => setOdds(e.target.value)} aria-invalid={!oddsOk} />
          </label>
          <label className="field">
            <span>Stake (units)</span>
            <input inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} aria-invalid={!stakeOk} />
          </label>
          <label className="field">
            <span>Sportsbook</span>
            <input value={book} onChange={(e) => setBook(e.target.value)} placeholder="FanDuel" />
          </label>
          <label className="field">
            <span>Result</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as BetStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {oddsOk && stakeOk && (
          <p className="calc">
            To win <b>{(u * (toDecimal(a) - 1)).toFixed(2)}u</b>
            {unit > 0 && <> ({fmtMoney(u * unit * (toDecimal(a) - 1))})</>} · break-even <b>{fmtPct(breakEven(a))}</b>
          </p>
        )}

        <label className="field">
          <span>Notes</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reasoning, injury notes…" />
        </label>

        {valid && status === 'pending' && (
          <SendToBook picks={isParlay ? draft.legs ?? [] : [{ ...(draft as Bet), ...selectionFields() }]} title={isParlay ? label : undefined} />
        )}

        <div className="actions">
          {editing && (
            <button type="button" className="btn danger" onClick={() => confirm('Delete this bet?') && onDelete(draft.id!)}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {linked && !editing && (
            <button type="button" className="btn" disabled={!valid} onClick={addLeg}>
              Add to parlay{slipCount > 0 && ` (${slipCount + 1})`}
            </button>
          )}
          <button className="btn primary" disabled={!valid || !stakeOk}>
            {editing ? 'Save' : 'Track bet'}
          </button>
        </div>
      </form>
    </div>
  );
}
