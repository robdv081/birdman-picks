import { useEffect, useRef, useState } from 'react';
import { LEAGUE_KEYS, type Game, type LeagueKey } from './espn';
import { fmtUnits, profit, type Bet, type Leg } from './bets';
import type { Lineup } from './fantasy';
import { captureCloses, closeKey, gradableKey, gradePending } from './grader';
import { SEED_BETS, SEED_LINEUPS } from './seed';
import { notify } from './alerts';
import { useStored } from './store';
import Scores from './components/Scores';
import Bets from './components/Bets';
import Fantasy from './components/Fantasy';
import BetModal from './components/BetModal';
import GameDetails from './components/GameDetails';
import ParlaySlip from './components/ParlaySlip';
import PropBuilder from './components/PropBuilder';
import Today from './components/Today';

type Route = { view: 'today' } | { view: 'scores'; league: LeagueKey } | { view: 'props' } | { view: 'bets' } | { view: 'fantasy' };

function parseHash(): Route {
  const h = location.hash.replace('#', '');
  if (h === '' || h === 'today') return { view: 'today' };
  if (h === 'props') return { view: 'props' };
  if (h === 'bets') return { view: 'bets' };
  if (h === 'fantasy') return { view: 'fantasy' };
  return { view: 'scores', league: (LEAGUE_KEYS as string[]).includes(h) ? (h as LeagueKey) : 'nba' };
}

/** Settles pending bets, parlay legs and props linked to ESPN games once those games go final. */
function useAutoGrade(bets: Bet[], setBets: (fn: (prev: Bet[]) => Bet[]) => void) {
  const key = gradableKey(bets);
  const betsRef = useRef(bets);
  betsRef.current = bets;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    async function run() {
      const updates = await gradePending(betsRef.current);
      for (const [id, u] of updates) {
        const b = betsRef.current.find((x) => x.id === id);
        if (b && u.status && u.status !== 'pending') {
          const settled = { ...b, ...u };
          notify(u.status === 'won' ? 'Bet won' : u.status === 'lost' ? 'Bet lost' : `Bet ${u.status}`, `${b.selection} · ${fmtUnits(profit(settled))}`, `${id}-settled`);
        }
      }
      if (!cancelled && updates.size)
        setBets((prev) => prev.map((b) => (b.status === 'pending' && updates.has(b.id) ? { ...b, ...updates.get(b.id) } : b)));
    }
    run();
    const t = setInterval(run, 120_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key, setBets]);
}

/** Fills in closing lines once games start, for closing line value on the report card. */
function useCloseCapture(bets: Bet[], setBets: (fn: (prev: Bet[]) => Bet[]) => void) {
  const key = closeKey(bets);
  const betsRef = useRef(bets);
  betsRef.current = bets;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    async function run() {
      const updates = await captureCloses(betsRef.current);
      if (cancelled || !updates.size) return;
      setBets((prev) =>
        prev.map((b) => {
          const u = updates.get(b.id);
          if (!u) return b;
          // Merge leg by leg so a grading pass that landed in between isn't overwritten.
          if (u.legs && b.legs) return { ...b, legs: b.legs.map((l, i) => ({ ...l, ...pickClose(u.legs![i]) })) };
          return { ...b, ...pickClose(u) };
        })
      );
    }
    run();
    const t = setInterval(run, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key, setBets]);
}

const pickClose = (s?: Partial<Bet>) => (s ? { closeOdds: s.closeOdds, closeLine: s.closeLine, closeChecked: s.closeChecked } : {});

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [bets, setBets] = useStored<Bet[]>('bp.bets', () => SEED_BETS);
  const [lineups, setLineups] = useStored<Lineup[]>('bp.lineups', () => SEED_LINEUPS);
  const [slip, setSlip] = useStored<Leg[]>('bp.slip', () => []);
  const [draft, setDraft] = useState<Partial<Bet> | null>(null);
  const [details, setDetails] = useState<{ game: Game; date: string } | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useAutoGrade(bets, setBets);
  useCloseCapture(bets, setBets);

  const saveBet = (b: Bet) => {
    setBets((prev) => (prev.some((x) => x.id === b.id) ? prev.map((x) => (x.id === b.id ? b : x)) : [b, ...prev]));
    setDraft(null);
  };
  const deleteBet = (id: string) => {
    setBets((prev) => prev.filter((x) => x.id !== id));
    setDraft(null);
  };
  const addLeg = (leg: Leg) => {
    setSlip((prev) => [...prev, leg]);
    setDraft(null);
  };

  const pendingCount = bets.filter((b) => b.status === 'pending').length;
  const lastLeague = useRef<LeagueKey>('nba');
  if (route.view === 'scores') lastLeague.current = route.league;

  return (
    <div className={`app ${slip.length ? 'has-slip' : ''}`}>
      <header className="topbar">
        <a className="brand" href="#today">
          <img src="icon.svg" alt="" width={28} height={28} />
          <span>Birdman Picks</span>
        </a>
        <nav className="tabs" aria-label="Sections">
          <a className={route.view === 'today' ? 'on' : ''} href="#today">
            Today
          </a>
          <a className={route.view === 'scores' ? 'on' : ''} href={`#${lastLeague.current}`}>
            Scores
          </a>
          <a className={route.view === 'props' ? 'on' : ''} href="#props">
            Props
          </a>
          <a className={route.view === 'bets' ? 'on' : ''} href="#bets">
            Bets{pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </a>
          <a className={route.view === 'fantasy' ? 'on' : ''} href="#fantasy">
            Fantasy
          </a>
        </nav>
      </header>

      <main className="content">
        {route.view === 'today' && <Today bets={bets} setSlip={setSlip} />}
        {route.view === 'scores' && (
          <Scores
            league={route.league}
            bets={bets}
            onTrack={(d) => setDraft(d)}
            onDetails={(game, date) => setDetails({ game, date })}
          />
        )}
        {route.view === 'props' && <PropBuilder setSlip={setSlip} />}
        {route.view === 'bets' && (
          <Bets bets={bets} setBets={setBets} lineups={lineups} setLineups={setLineups} onEdit={(b) => setDraft(b ?? {})} />
        )}
        {route.view === 'fantasy' && <Fantasy lineups={lineups} setLineups={setLineups} />}
      </main>

      <footer className="foot">
        Scores, odds and injuries from ESPN's public feed and may be delayed. This app tracks picks and hands them to DraftKings or FanDuel; it never places bets itself.
      </footer>

      {details && (
        <GameDetails
          game={details.game}
          date={details.date}
          onClose={() => setDetails(null)}
          onTrack={(d) => setDraft(d)}
        />
      )}
      {draft && (
        <BetModal
          draft={draft}
          slipCount={slip.length}
          onSave={saveBet}
          onAddLeg={addLeg}
          onDelete={deleteBet}
          onClose={() => setDraft(null)}
        />
      )}
      {slip.length > 0 && <ParlaySlip slip={slip} setSlip={setSlip} onSave={(b) => saveBet(b)} />}
    </div>
  );
}
