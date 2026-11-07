import { useState } from 'react';
import type { Lineup } from '../fantasy';
import { SPORT_LABEL } from '../dfs';
import { gradeSnapshot, loadSnapshots, slateSummaries, type ReportCard, type Snapshot } from '../snapshots';
import { fantasyPoints } from '../stats';
import { fmtDate, todayYMD } from '../store';

interface LineupResult {
  title: string;
  projected: number;
  actual: number;
}

export default function ProjectionReport({ lineups }: { lineups: Lineup[] }) {
  const [snaps] = useState<Snapshot[]>(loadSnapshots);
  const [open, setOpen] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, ReportCard | 'loading' | string>>({});
  const [results, setResults] = useState<Record<string, LineupResult[]>>({});
  const past = snaps.filter((s) => s.date <= todayYMD());

  const grade = async (s: Snapshot) => {
    setOpen(open === s.slateId ? null : s.slateId);
    if (cards[s.slateId] && cards[s.slateId] !== 'loading' && typeof cards[s.slateId] !== 'string') return;
    setCards((c) => ({ ...c, [s.slateId]: 'loading' }));
    try {
      const card = await gradeSnapshot(s);
      setCards((c) => ({ ...c, [s.slateId]: card }));
      // Generated lineups from this slate: projected vs. what they scored.
      const mine = lineups.filter((l) => l.slateId === s.slateId && l.projected != null);
      if (mine.length) {
        const { summaries } = await slateSummaries(s);
        setResults((r) => ({
          ...r,
          [s.slateId]: mine.map((l) => ({
            title: l.title,
            projected: l.projected!,
            actual: l.slots.reduce((sum, x) => sum + (x.points ?? fantasyPoints(summaries, x.player, l.templateId) ?? 0), 0),
          })),
        }));
      }
    } catch (e) {
      setCards((c) => ({ ...c, [s.slateId]: `Couldn't grade: ${(e as Error).message}` }));
    }
  };

  return (
    <section className="card report projreport">
      <h2>Projection report card</h2>
      {past.length === 0 ? (
        <p className="muted small">
          Every time you build projections, they're saved here. After the games, grade them to see how close they came: the
          average miss, whether they ran high or low, and how your generated lineups scored against their projections.
        </p>
      ) : (
        <ul className="snaplist">
          {past.map((s) => {
            const card = cards[s.slateId];
            const isOpen = open === s.slateId;
            return (
              <li key={s.slateId}>
                <button className="lhead" onClick={() => grade(s)} aria-expanded={isOpen}>
                  <span>
                    <b>
                      {s.site === 'dk' ? 'DraftKings' : 'FanDuel'} {SPORT_LABEL[s.sport]} · {s.label}
                    </b>
                    <small>
                      {fmtDate(s.date)} · {s.players.length} players projected
                    </small>
                  </span>
                  <span className="muted small">{isOpen ? 'Hide' : 'Grade'} →</span>
                </button>
                {isOpen && card === 'loading' && <p className="muted small">Scoring every player from the box scores…</p>}
                {isOpen && typeof card === 'string' && card !== 'loading' && <p className="warn small">{card}</p>}
                {isOpen && card && typeof card === 'object' && <CardView card={card} results={results[s.slateId]} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CardView({ card, results }: { card: ReportCard; results?: LineupResult[] }) {
  if (!card.graded.length)
    return <p className="muted small">No games have finished yet ({card.finals} of {card.games} final). Check back after the slate.</p>;
  const misses = [...card.graded].sort((a, b) => Math.abs(b.proj - b.actual) - Math.abs(a.proj - a.actual)).slice(0, 6);
  const f = (n: number) => n.toFixed(1);
  return (
    <div className="cardview">
      {card.finals < card.games && <p className="muted small">{card.finals} of {card.games} games final so far.</p>}
      <div className="stats">
        <div className="stat">
          <small>Average miss</small>
          <b>{f(card.mae)} pts</b>
        </div>
        <div className="stat">
          <small>Lean</small>
          <b className={Math.abs(card.bias) < 1 ? 'pos' : 'neg'}>
            {Math.abs(card.bias) < 0.5 ? 'On target' : `${f(Math.abs(card.bias))} ${card.bias > 0 ? 'high' : 'low'}`}
          </b>
        </div>
        <div className="stat">
          <small>Ranking accuracy</small>
          <b>{card.corr.toFixed(2)}</b>
          <span className="muted sub">1.00 is perfect</span>
        </div>
        <div className="stat">
          <small>Top 10 beat proj.</small>
          <b>{card.topHit}/10</b>
        </div>
      </div>
      <p className="muted small">
        Graded {card.graded.length} players. "Ranking accuracy" is how well the order of projections matched the order of actual
        scores (correlation).
      </p>

      {results && results.length > 0 && (
        <div>
          <h3>Your generated lineups</h3>
          <ul className="rlist">
            {results.map((r, i) => (
              <li key={i}>
                <span>{r.title}</span>
                <small className="muted">proj {f(r.projected)}</small>
                <b className={r.actual >= r.projected ? 'pos' : 'neg'}>{f(r.actual)} pts</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>By position</h3>
      <ul className="rlist">
        {card.byPos.map((p) => (
          <li key={p.pos}>
            <span>
              {p.pos} <small className="muted">{p.n} players</small>
            </span>
            <small className="muted">miss {f(p.mae)}</small>
            <b className={Math.abs(p.bias) < 1 ? '' : 'neg'}>{p.bias >= 0 ? '+' : ''}{f(p.bias)}</b>
          </li>
        ))}
      </ul>

      <h3>Biggest misses</h3>
      <ul className="rlist">
        {misses.map((m) => (
          <li key={m.name}>
            <span>
              {m.name} <small className="muted">{m.team}</small>
            </span>
            <small className="muted">proj {f(m.proj)}</small>
            <b className={m.actual >= m.proj ? 'pos' : 'neg'}>{f(m.actual)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
