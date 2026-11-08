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
import { LineShopPick } from './LineShop';
import { checkStake, HELPLINE } from '../guard';
import { ownerKey, postRecordPick, serverReady } from '../server';
import { currentPlayer, postPlayerPick, STAKE_RANGE } from '../players';
import { onBreakUntil } from '../tilt';

interface Props {
  draft: Partial<Bet>;
  /** Everything tracked so far, for the weekly limit. */
  bets: Bet[];
  slipCount: number;
  onSave: (b: Bet) => void;
  onAddLeg: (l: Leg) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const STATUSES: BetStatus[] = ['pending', 'won', 'lost', 'push', 'void'];

export default function BetModal({ draft, bets, slipCount, onSave, onAddLeg, onDelete, onClose }: Props) {
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
  const owner = serverReady() && !!ownerKey();
  const contestant = serverReady() ? currentPlayer() : null;
  // A break the bettor chose (tilt detector): new bets wait until it's over.
  const breakUntil = editing ? 0 : onBreakUntil();
  const canPost = linked && !isParlay && !editing && ['ml', 'spread', 'total', 'prop'].includes(draft.market ?? '');

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
  // Weekly limit: only new bets, or edits that raise the stake, count against it.
  const guard = stakeOk && status === 'pending' ? checkStake(bets, u, draft.id) : null;
  const overLimit = !!guard?.over && (!editing || u > (draft.stake ?? 0));

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
    if (overLimit && !confirm(`This takes you to ${guard!.after.toFixed(1)}u this week, over your ${guard!.limit}u limit. Track it anyway?`)) return;
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

        {oddsOk && linked && !isParlay && (
          <LineShopPick league={draft.league} eventId={draft.eventId} market={market} side={draft.side} line={draft.line} odds={a} />
        )}

        {overLimit && (
          <p className="warn">
            Over your weekly limit: this makes <b>{guard!.after.toFixed(1)}u</b> in play this week against your {guard!.limit}u limit. Need a break? {HELPLINE}{' '}
            is free and confidential.
          </p>
        )}
        {!overLimit && guard && guard.after >= guard.limit * 0.8 && (
          <p className="muted small">
            {guard.after.toFixed(1)}u of your {guard.limit}u weekly limit with this bet.
          </p>
        )}

        {oddsOk && stakeOk && (
          <p className="calc">
            To win <b>{(u * (toDecimal(a) - 1)).toFixed(2)}u</b>
            {unit > 0 && <> ({fmtMoney(u * unit * (toDecimal(a) - 1))})</>} · break-even <b>{fmtPct(breakEven(a))}</b>
          </p>
        )}

        <label className="field">
          <span>{owner && canPost ? 'Notes (also "Why I like it" on your record)' : 'Notes'}</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reasoning, injury notes…" />
        </label>

        {contestant && canPost && valid && !breakUntil && (
          <PlayerPost
            name={contestant.name}
            pick={{
              league: draft.league!,
              eventId: draft.eventId!,
              date,
              market,
              side: linkedProp ? side : draft.side!,
              line: linkedProp ? lineNum : draft.line,
              odds: a,
              reason: notes.trim(),
              player: linkedProp ? player.trim() : undefined,
              stat: linkedProp ? stat : undefined,
            }}
          />
        )}
        {!contestant && serverReady() && canPost && valid && !breakUntil && (
          <p className="muted small">
            Free weekly contest: <a href="#compete">pick a player name</a> to post picks like this to your own verified record.
          </p>
        )}

        {breakUntil > 0 && (
          <div className="card tilt calm">
            <b>☕ You're on a break until {new Date(breakUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.</b>
            <p className="muted small">
              You chose to pause new bets. You can end the break on the Bets tab. Need to talk? {HELPLINE}, free and 24/7.
            </p>
          </div>
        )}

        {owner && canPost && valid && stakeOk && !breakUntil && (
          <PostToRecord
            pick={{
              league: draft.league!,
              eventId: draft.eventId!,
              date,
              market,
              side: linkedProp ? side : draft.side!,
              line: linkedProp ? lineNum : draft.line,
              odds: a,
              units: u,
              reason: notes.trim(),
              player: linkedProp ? player.trim() : undefined,
              stat: linkedProp ? stat : undefined,
            }}
          />
        )}

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
          <button className="btn primary" disabled={!valid || !stakeOk || breakUntil > 0}>
            {editing ? 'Save' : 'Track bet'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Owner only: put this pick on the public, locked record. */
function PostToRecord({ pick }: { pick: Parameters<typeof postRecordPick>[0] }) {
  const [state, setState] = useState<'idle' | 'posting' | 'done'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const post = async () => {
    if (!confirm(`Post ${fmtUnitsShort(pick.units)} on this pick to your public record? It locks now and can't be edited or deleted.`)) return;
    setState('posting');
    setMsg(null);
    try {
      const r = await postRecordPick(pick);
      setState('done');
      setMsg(`Posted as pick #${r.pick.seq}.`);
    } catch (e) {
      setState('idle');
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="postrecord">
      <button type="button" className="btn gold" disabled={state !== 'idle'} onClick={post}>
        {state === 'posting' ? 'Posting…' : state === 'done' ? 'On your record ✓' : 'Post to my record'}
      </button>
      <small className="muted">{msg ?? 'Locks it with a timestamp. Your notes show as "Why I like it".'}</small>
    </div>
  );
}

const fmtUnitsShort = (u: number) => `${u}u`;

/** Players: put this pick on your own verified record; it's also your entry in this week's contest. */
function PlayerPost({ name, pick }: { name: string; pick: Omit<Parameters<typeof postRecordPick>[0], 'units'> }) {
  const [stake, setStake] = useState('100');
  const [state, setState] = useState<'idle' | 'posting' | 'done'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const n = Math.round(Number(stake));
  const ok = n >= STAKE_RANGE[0] && n <= STAKE_RANGE[1];
  const post = async () => {
    if (!confirm(`Post this pick to ${name}'s record for ${n} contest points? It locks now and can't be edited or deleted.`)) return;
    setState('posting');
    setMsg(null);
    try {
      const r = await postPlayerPick(pick, n);
      setState('done');
      setMsg(`Posted. ${Math.floor(r.week.available).toLocaleString()} points left this week.`);
    } catch (e) {
      setState('idle');
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="postrecord player">
      <label className="field inline">
        <span>Contest points</span>
        <input inputMode="numeric" value={stake} onChange={(e) => setStake(e.target.value)} disabled={state !== 'idle'} />
      </label>
      <button type="button" className="btn gold" disabled={state !== 'idle' || !ok} onClick={post}>
        {state === 'posting' ? 'Posting…' : state === 'done' ? 'On your record ✓' : 'Post to my record & contest'}
      </button>
      <small className="muted">{msg ?? `As ${name}. ${STAKE_RANGE[0]}–${STAKE_RANGE[1]} points of your weekly 1,000.`}</small>
    </div>
  );
}
