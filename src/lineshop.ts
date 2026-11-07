// Line shopping: every sportsbook ESPN carries for a game, and which one pays best for each side.
import { LEAGUES, parseAmerican, type LeagueKey } from './espn';
import { toDecimal, type BetSide, type Market } from './bets';
import { getJson, pool, type Json } from './market';

export interface BookLine {
  book: string;
  awayML?: number;
  homeML?: number;
  draw?: number;
  awaySpread?: { line: number; odds?: number };
  homeSpread?: { line: number; odds?: number };
  over?: { line: number; odds?: number };
  under?: { line: number; odds?: number };
}

export interface Offer {
  book: string;
  odds: number;
  line?: number;
}

// ESPN also lists models and consensus numbers next to real sportsbooks; those aren't places to bet.
const NOT_BOOKS = /consensus|teamrankings|numberfire|accuscore|projection|model|power index|bpi|fpi/i;

const num = (v: unknown) => {
  if (v == null || v === '') return undefined;
  const n = parseFloat(String(v).replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? n : undefined;
};
const price = (v: unknown) => (typeof v === 'number' ? (v !== 0 && Math.abs(v) >= 100 ? Math.round(v) : undefined) : parseAmerican(v));

/** One provider's odds item from ESPN's core API, in either of the shapes it uses. */
export function parseBook(o: Json): BookLine | null {
  const name: string = o?.provider?.displayName ?? o?.provider?.name ?? '';
  if (!name || NOT_BOOKS.test(name)) return null;
  const cur = (t: Json) => t?.current ?? t?.close ?? {};
  const a = o.awayTeamOdds ?? {};
  const h = o.homeTeamOdds ?? {};
  const c = cur(o);

  const homeLine = num(cur(h).pointSpread?.american) ?? (typeof o.spread === 'number' ? o.spread : undefined);
  const awayLine = num(cur(a).pointSpread?.american) ?? (homeLine != null ? -homeLine : undefined);
  const total = num(c.total?.american) ?? (typeof o.overUnder === 'number' ? o.overUnder : undefined);

  const b: BookLine = {
    book: name,
    awayML: price(cur(a).moneyLine?.american) ?? price(a.moneyLine),
    homeML: price(cur(h).moneyLine?.american) ?? price(h.moneyLine),
    draw: price(o.drawOdds?.moneyLine) ?? price(cur(o.drawOdds).moneyLine?.american),
  };
  if (awayLine != null) b.awaySpread = { line: awayLine, odds: price(cur(a).spread?.american) ?? price(a.spreadOdds) };
  if (homeLine != null) b.homeSpread = { line: homeLine, odds: price(cur(h).spread?.american) ?? price(h.spreadOdds) };
  if (total != null) {
    b.over = { line: total, odds: price(c.over?.american) ?? price(o.overOdds) };
    b.under = { line: total, odds: price(c.under?.american) ?? price(o.underOdds) };
  }
  const any = b.awayML ?? b.homeML ?? b.awaySpread?.odds ?? b.over?.odds;
  return any != null ? b : null;
}

const cache = new Map<string, { at: number; p: Promise<BookLine[]> }>();

/** Every sportsbook's current line for a game. Cached for two minutes. */
export function fetchBookLines(league: LeagueKey, eventId: string): Promise<BookLine[]> {
  const k = `${league}|${eventId}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 120_000) return hit.p;
  const p = (async () => {
    const [sport, lg] = LEAGUES[league].path.split('/');
    const list = await getJson(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${lg}/events/${eventId}/competitions/${eventId}/odds?limit=50`);
    const items: Json[] = list.items ?? [];
    // Some leagues return links instead of the odds themselves; follow those.
    const full: Json[] = [];
    await pool(items, 4, async (it) => {
      if (it?.provider || !it?.$ref) full.push(it);
      else full.push(await getJson(String(it.$ref).replace(/^http:/, 'https:')).catch(() => null));
    });
    const seen = new Set<string>();
    return full
      .map(parseBook)
      .filter((b): b is BookLine => !!b && !seen.has(b.book) && !!seen.add(b.book));
  })();
  cache.set(k, { at: Date.now(), p });
  p.catch(() => cache.delete(k));
  return p;
}

/** Every book's offer on one side, best first: more points on your side, then the better price. */
export function offers(books: BookLine[], market: Market, side: BetSide): Offer[] {
  const out: Offer[] = [];
  for (const b of books) {
    if (market === 'ml') {
      const o = side === 'home' ? b.homeML : side === 'away' ? b.awayML : b.draw;
      if (o != null) out.push({ book: b.book, odds: o });
    } else {
      const q = market === 'spread' ? (side === 'home' ? b.homeSpread : b.awaySpread) : market === 'total' ? (side === 'over' ? b.over : b.under) : undefined;
      if (q?.odds != null) out.push({ book: b.book, odds: q.odds, line: q.line });
    }
  }
  const lineScore = (o: Offer) => (o.line == null ? 0 : market === 'total' ? (side === 'over' ? -o.line : o.line) : o.line);
  return out.sort((x, y) => lineScore(y) - lineScore(x) || toDecimal(y.odds) - toDecimal(x.odds));
}

/** Extra profit per unit from taking `best` instead of `yours` at the same line. */
export function priceGain(best: number, yours: number) {
  return toDecimal(best) - toDecimal(yours);
}
