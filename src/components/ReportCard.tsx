import { useMemo } from 'react';
import { fmtPct, fmtUnits, type Bet } from '../bets';
import { autopsy, clvReport, tendencies, type Tendency } from '../insights';
import { fmtDate } from '../store';

export default function ReportCard({ bets }: { bets: Bet[] }) {
  const c = useMemo(() => clvReport(bets), [bets]);
  const a = useMemo(() => autopsy(bets), [bets]);
  const t = useMemo(() => tendencies(bets), [bets]);
  const empty = !c.measured && !a.parlaysSettled && !a.nearMisses.length && !t.best.length && !t.worst.length;

  return (
    <section className="card report">
      <h2>Report card</h2>
      {empty && (
        <p className="muted small">
          Fills in as tracked bets settle: closing line value, how your parlays die, and which bets make or cost you money.
          Bets tracked from the Scores or Props tabs give the most detail.
        </p>
      )}

      {c.measured > 0 && (
        <div className="rsec">
          <h3>Closing line value</h3>
          <div className="rbig">
            <b className={c.beat / c.measured >= 0.5 ? 'pos' : 'neg'}>{fmtPct(c.beat / c.measured)}</b>
            <span>
              of your picks beat DraftKings' closing line ({c.beat} of {c.measured})
            </span>
          </div>
          <p className="muted small">
            {c.avgProb != null && (
              <>
                Average price edge vs. the close: <b className={c.avgProb > 0 ? 'pos' : 'neg'}>{c.avgProb > 0 ? '+' : ''}{(c.avgProb * 100).toFixed(1)} pts</b> of win probability.{' '}
              </>
            )}
            {c.avgPoints != null && (
              <>
                Where the line moved: <b className={c.avgPoints > 0 ? 'pos' : 'neg'}>{c.avgPoints > 0 ? '+' : ''}{c.avgPoints.toFixed(1)}</b> points on average.{' '}
              </>
            )}
            Beating the close consistently is the best sign of real skill, more than a hot record.
          </p>
        </div>
      )}

      {(a.parlaysSettled > 0 || a.nearMisses.length > 0) && (
        <div className="rsec">
          <h3>Parlay autopsy</h3>
          {a.parlaysLost > 0 && (
            <div className="rbig">
              <b className={a.oneLegAway ? 'neg' : ''}>{a.oneLegAway}</b>
              <span>
                of {a.parlaysLost} losing parlay{a.parlaysLost === 1 ? '' : 's'} died by a single leg
              </span>
            </div>
          )}
          {a.legTypes.length > 0 && (
            <ul className="rlist">
              {a.legTypes.slice(0, 4).map((l) => (
                <li key={l.label}>
                  <span>{l.label}</span>
                  <span className="hitbar wide">
                    <i style={{ width: `${(l.hit / l.total) * 100}%` }} />
                  </span>
                  <b>
                    {l.hit}/{l.total}
                  </b>
                </li>
              ))}
            </ul>
          )}
          {a.nearMisses.length > 0 && (
            <>
              <p className="muted small">Near misses</p>
              <ul className="rlist">
                {a.nearMisses.map((m, i) => (
                  <li key={i}>
                    <span>{m.label}</span>
                    <small className="muted">{fmtDate(m.date)}</small>
                    <b className="neg">missed by {m.margin}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {(t.best.length > 0 || t.worst.length > 0) && (
        <div className="rsec">
          <h3>Your tendencies</h3>
          <div className="tgrid">
            {t.best.length > 0 && <TendencyList title="Keep doing" rows={t.best} />}
            {t.worst.length > 0 && <TendencyList title="Costing you" rows={t.worst} />}
          </div>
          <p className="muted small">Groups with at least 3 settled bets. Small samples swing, so watch for patterns that hold over weeks.</p>
        </div>
      )}
    </section>
  );
}

function TendencyList({ title, rows }: { title: string; rows: Tendency[] }) {
  return (
    <div>
      <small className="muted">{title}</small>
      <ul className="rlist">
        {rows.map((r) => (
          <li key={r.label}>
            <span>{r.label}</span>
            <small className="muted">
              {r.won}-{r.lost}
            </small>
            <b className={r.profit > 0 ? 'pos' : 'neg'}>
              {fmtUnits(r.profit)} · {fmtPct(r.yield)}
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}
