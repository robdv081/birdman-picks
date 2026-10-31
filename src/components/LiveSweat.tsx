import { useEffect, useRef, useState } from 'react';
import { fmtAmerican, fmtUnits, toDecimal, type Bet } from '../bets';
import { gradableKey } from '../grader';
import { sweatBets, type BetLive } from '../live';

const REFRESH_MS = 30_000;

export default function LiveSweat({ bets, compact = false }: { bets: Bet[]; compact?: boolean }) {
  const [rows, setRows] = useState<BetLive[]>([]);
  const [updated, setUpdated] = useState<Date | null>(null);
  const betsRef = useRef(bets);
  betsRef.current = bets;
  const key = gradableKey(bets);

  useEffect(() => {
    if (!key) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      if (document.hidden) return;
      const r = await sweatBets(betsRef.current);
      if (!cancelled) {
        setRows(r);
        setUpdated(new Date());
      }
    };
    run();
    const t = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key]);

  if (!rows.length) return null;
  const anyLive = rows.some((r) => r.live > 0);

  return (
    <section className={`sweat ${compact ? 'compact' : ''}`}>
      <div className="row between">
        <h2>
          <span className={`dot ${anyLive ? 'live' : ''}`} /> {anyLive ? 'Sweating now' : "Tonight's action"}
        </h2>
        {updated && <small className="muted">Updated {updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>}
      </div>
      <div className="sweatlist">
        {rows.map((r) => (
          <SweatCard key={r.bet.id} r={r} compact={compact} />
        ))}
      </div>
    </section>
  );
}

function SweatCard({ r, compact }: { r: BetLive; compact: boolean }) {
  const { bet, legs, won, lost, live } = r;
  const total = legs.length;
  const left = total - won;
  const toWin = bet.stake * (toDecimal(bet.odds) - 1);
  const headline = lost
    ? 'Busted'
    : won === total
      ? 'All legs hit'
      : left === 1 && total > 1
        ? 'One leg away'
        : live
          ? `${won}/${total} hit · ${live} live`
          : `${won}/${total} hit`;

  return (
    <article className={`card sweatcard ${lost ? 'dead' : left === 1 && total > 1 ? 'close' : ''}`}>
      <header className="row between">
        <div>
          <b>{bet.selection}</b>
          <small className="muted">
            {' '}
            {fmtAmerican(bet.odds)} · to win {fmtUnits(toWin).replace('+', '')}
          </small>
        </div>
        <span className={`pill ${lost ? 'lost' : won === total ? 'won' : 'pending'}`}>{headline}</span>
      </header>
      {(!compact || total > 1) && (
        <ul className="sweatlegs">
          {legs.map((l, i) => (
            <li key={i} className={l.state}>
              <div className="row between">
                <span className="lsel">
                  <i className={`ldot ${l.state}`} />
                  {l.sel.selection}
                </span>
                {l.clock && l.state === 'live' && <small className="muted">{l.clock}</small>}
              </div>
              {l.progress != null && l.state !== 'upcoming' && (
                <span className={`bar ${l.state}`}>
                  <i style={{ width: `${Math.round(l.progress * 100)}%` }} />
                </span>
              )}
              <small className="ltext">{l.text}</small>
            </li>
          ))}
        </ul>
      )}
      {compact && total === 1 && <small className="ltext">{legs[0].text}</small>}
    </article>
  );
}
