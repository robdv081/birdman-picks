import { useEffect, useState } from 'react';
import type { Game, LeagueKey } from '../espn';
import { fmtAmerican, fmtLine, type BetSide, type Market } from '../bets';
import { fetchBookLines, offers, priceGain, type BookLine, type Offer } from '../lineshop';

function useBooks(league?: LeagueKey, eventId?: string) {
  const [books, setBooks] = useState<BookLine[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!league || !eventId) return;
    let live = true;
    setBooks(null);
    setError(false);
    fetchBookLines(league, eventId).then(
      (b) => live && setBooks(b),
      () => live && setError(true)
    );
    return () => {
      live = false;
    };
  }, [league, eventId]);
  return { books, error };
}

const offerText = (o: Offer, market: Market) => `${market === 'spread' && o.line != null ? `${fmtLine(o.line)} ` : market === 'total' && o.line != null ? `${o.line} ` : ''}${fmtAmerican(o.odds)}`;

/** Every side of a game with the book paying best on each. */
export function LineShopGame({ game: g }: { game: Game }) {
  const { books, error } = useBooks(g.league, g.id);
  const [open, setOpen] = useState<string | null>(null);
  if (g.state !== 'pre') return null;

  const sides: { key: string; label: string; market: Market; side: BetSide }[] = [
    { key: 'aml', label: `${g.away.abbr} ML`, market: 'ml', side: 'away' },
    { key: 'hml', label: `${g.home.abbr} ML`, market: 'ml', side: 'home' },
    ...(g.odds?.draw != null ? [{ key: 'dml', label: 'Draw', market: 'ml' as Market, side: 'draw' as BetSide }] : []),
    { key: 'asp', label: `${g.away.abbr} spread`, market: 'spread', side: 'away' },
    { key: 'hsp', label: `${g.home.abbr} spread`, market: 'spread', side: 'home' },
    { key: 'ov', label: 'Over', market: 'total', side: 'over' },
    { key: 'un', label: 'Under', market: 'total', side: 'under' },
  ];

  return (
    <div className="card lineshop">
      <div className="row between">
        <b>Best prices</b>
        <small className="muted">{books ? `${books.length} sportsbook${books.length === 1 ? '' : 's'}` : ''}</small>
      </div>
      {error && <p className="muted small">Couldn't load other sportsbooks' lines right now.</p>}
      {!books && !error && <p className="muted small">Comparing sportsbooks…</p>}
      {books && books.length < 2 && (
        <p className="muted small">ESPN only has {books[0]?.book ?? 'one sportsbook'}'s line for this game, so there's nothing to compare yet.</p>
      )}
      {books && books.length >= 2 && (
        <ul className="shoplist">
          {sides.map((s) => {
            const list = offers(books, s.market, s.side);
            if (!list.length) return null;
            const best = list[0];
            const isOpen = open === s.key;
            return (
              <li key={s.key}>
                <button className="shoprow" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.key)}>
                  <span>{s.label}</span>
                  <span className="muted small">{best.book}</span>
                  <b>{offerText(best, s.market)}</b>
                </button>
                {isOpen && (
                  <ul className="shopall">
                    {list.map((o) => (
                      <li key={o.book}>
                        <span>{o.book}</span>
                        <span className={o === best ? 'pos' : ''}>{offerText(o, s.market)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">Same bet, better payout: take the best price you can get. Tap a side to see every book.</p>
    </div>
  );
}

/** One pick: is another book paying more than the price you have? */
export function LineShopPick({ league, eventId, market, side, line, odds }: { league?: LeagueKey; eventId?: string; market: Market; side?: BetSide; line?: number; odds: number }) {
  const shoppable = !!league && !!eventId && !!side && (market === 'ml' || market === 'spread' || market === 'total');
  const { books } = useBooks(shoppable ? league : undefined, shoppable ? eventId : undefined);
  if (!shoppable || !books || books.length < 2) return null;
  const list = offers(books, market, side!);
  const sameLine = list.filter((o) => line == null || o.line == null || Math.abs(o.line - line) < 0.01);
  const best = sameLine[0];
  const betterLine = list[0] && list[0].line != null && line != null && list[0] !== best ? list[0] : null;
  if (!best) return null;
  const gain = priceGain(best.odds, odds);
  return (
    <p className="shoppick small">
      {gain >= 0.005 ? (
        <>
          🔎 Better price: <b>{best.book} {fmtAmerican(best.odds)}</b> pays {(gain * 100).toFixed(0)}¢ more per $1 than {fmtAmerican(odds)}.
        </>
      ) : (
        <>🔎 {fmtAmerican(odds)} is the best price out of {books.length} books.</>
      )}
      {betterLine && (
        <>
          {' '}
          {betterLine.book} has a better number: {offerText(betterLine, market)}.
        </>
      )}
    </p>
  );
}
