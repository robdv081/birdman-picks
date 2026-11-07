import { useState } from 'react';
import { breakEven, fmtAmerican, fmtPct, newId, parlayOdds, toDecimal, type Bet, type Leg } from '../bets';
import { StakeNote } from './PropBuilder';

interface Props {
  slip: Leg[];
  setSlip: (fn: Leg[] | ((prev: Leg[]) => Leg[])) => void;
  onSave: (b: Bet) => void;
}

export default function ParlaySlip({ slip, setSlip, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const computed = parlayOdds(slip);
  const [override, setOverride] = useState('');
  const [stake, setStake] = useState('1');
  const [book, setBook] = useState('');

  const sameGame = new Set(slip.map((l) => l.eventId)).size < slip.length;
  const price = override.trim() ? Number(override.trim()) : computed;
  const priceOk = Number.isInteger(price) && Math.abs(price) >= 100;
  const u = Number(stake.trim());
  const ok = slip.length >= 2 && priceOk && Number.isFinite(u) && u > 0;

  const save = () => {
    if (!ok) return;
    const dates = slip.map((l) => l.date).sort();
    onSave({
      id: newId(),
      createdAt: new Date().toISOString(),
      date: dates[dates.length - 1],
      selection: `${slip.length}-leg parlay`,
      market: 'parlay',
      odds: price,
      stake: u,
      book: book.trim() || undefined,
      status: 'pending',
      legs: slip.map((l) => ({ ...l, status: 'pending' })),
    });
    setSlip([]);
    setOpen(false);
  };

  if (!open)
    return (
      <button className="slipbar" onClick={() => setOpen(true)}>
        <span className="badge">{slip.length}</span>
        <b>Parlay slip</b>
        <span className="muted">{slip.length >= 2 ? fmtAmerican(computed) : 'add one more leg'}</span>
        <span className="spacer" />
        <span>Review →</span>
      </button>
    );

  return (
    <div className="scrim" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Parlay slip</h2>
        <ul className="legs">
          {slip.map((l, i) => (
            <li key={i}>
              <span>{l.selection}</span>
              <small>
                {l.matchup} · {fmtAmerican(l.odds)}
              </small>
              <button className="x" aria-label={`Remove ${l.selection}`} onClick={() => setSlip((prev) => prev.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
        {slip.length < 2 && <p className="muted">Add at least two legs from the Scores tab or a game's details.</p>}
        {sameGame && (
          <p className="warn">Same-game legs are correlated. Sportsbooks price these differently, so enter the book's price below.</p>
        )}

        <div className="grid3">
          <label className="field">
            <span>Price</span>
            <input inputMode="numeric" value={override} onChange={(e) => setOverride(e.target.value)} placeholder={fmtAmerican(computed)} />
          </label>
          <label className="field">
            <span>Stake (units)</span>
            <input inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
          </label>
          <label className="field">
            <span>Sportsbook</span>
            <input value={book} onChange={(e) => setBook(e.target.value)} placeholder="FanDuel" />
          </label>
        </div>
        {ok && (
          <p className="calc">
            {fmtAmerican(price)} · to win <b>{(u * (toDecimal(price) - 1)).toFixed(2)}u</b> · break-even <b>{fmtPct(breakEven(price))}</b>
          </p>
        )}

        {ok && slip.every((l) => l.est != null) && <StakeNote p={slip.reduce((x, l) => x * l.est!, 1)} odds={price} />}
        <div className="actions">
          <button className="btn danger" onClick={() => setSlip([])}>
            Clear
          </button>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setOpen(false)}>
            Keep adding
          </button>
          <button className="btn primary" disabled={!ok} onClick={save}>
            Track parlay
          </button>
        </div>
      </div>
    </div>
  );
}
