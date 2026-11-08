import { useEffect, useState } from 'react';
import { api, serverReady } from '../server';
import { proBearer, usePro } from '../pro';
import { LEAGUES, type LeagueKey } from '../espn';
import type { AnalystPick, ScoutReport } from '../scout';
import { ProGate } from './Pro';
import ProAlerts from './ProAlerts';

const et = (s: string) => new Date(s).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
const ago = (s: string) => {
  const m = Math.round((Date.now() - Date.parse(s)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const fmtOdds = (o: number) => (o > 0 ? `+${o}` : `${o}`);
const label = (lg: string) => LEAGUES[lg as LeagueKey]?.label ?? lg.toUpperCase();

export default function Scout() {
  const pro = usePro();
  const [report, setReport] = useState<ScoutReport | null>(null);
  const [expired, setExpired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ report: ScoutReport | null; expired: boolean }>('/api/pro/scout', {
        headers: { Authorization: `Bearer ${proBearer()}` },
      });
      setReport(r.report);
      setExpired(r.expired);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }
  useEffect(() => {
    if (!pro.pro || !serverReady()) return;
    void refresh();
    const timer = setInterval(() => !document.hidden && refresh(), 5 * 60_000);
    return () => clearInterval(timer);
  }, [pro.pro]);

  const picks = (report?.candidates ?? []).filter((c) => Date.parse(c.start) > Date.now() + 10 * 60_000);

  return (
    <ProGate feature="Scout + Birdman Analyst" blurb="Today's slate researched every 30 minutes: injuries, prices and line moves, plus up to 3 paper picks with their sources and when to pass.">
      <section className="scout" aria-label="Scout and Analyst">
        <div className="row between">
          <h1>
            Scout <span className="pill pro">Pro</span>
          </h1>
          {serverReady() && (
            <button className="btn sm" onClick={refresh} disabled={busy}>
              {busy ? 'Checking…' : 'Refresh'}
            </button>
          )}
        </div>
        <ProAlerts />
        {error && <p role="alert" className="warn">{error}</p>}
        {!loaded && !error && <div className="empty">Loading today's research…</div>}
        {loaded && !report && !error && <div className="empty">Scout hasn't published today's research yet. It runs every 30 minutes from 10 AM to midnight ET.</div>}

        {report && (
          <>
            <p className="muted small">
              Checked {ago(report.checkedAt)} ·{' '}
              {report.feeds
                .filter((f) => f.events || !f.ok)
                .map((f) => `${label(f.league)} ${f.ok ? `${f.events} games` : 'unavailable'}${f.injuries ? ' + injuries' : ''}`)
                .join(' · ') || 'no games on today’s schedules'}
            </p>
            {expired && <div className="card warn">This research is out of date, so its picks are hidden. Scout checks again within 30 minutes.</div>}

            <h2>Birdman Analyst</h2>
            {picks.length ? (
              picks.map((c) => <AnalystCard key={c.league + c.eventId} c={c} />)
            ) : (
              <div className="card empty">
                <b>No verified picks.</b> Nothing on today's slate clears the bar: a 3–15 point model edge at a fair price, with the schedule,
                the price and availability all checked.
              </div>
            )}
            {report.passes.length > 0 && (
              <details className="card">
                <summary>What Analyst passed on ({report.passes.length})</summary>
                <ul className="small">
                  {report.passes.map((p, i) => (
                    <li key={i}>
                      <b>{p.event}</b>: {p.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <h2>Scout's notes</h2>
            {!report.games.length && <div className="empty">No upcoming games with prices right now.</div>}
            <ul className="scoutgames">
              {report.games.map((g) => (
                <li key={g.league + g.eventId} className="card">
                  <div className="row between">
                    <b>{g.matchup}</b>
                    <small className="muted">
                      {label(g.league)} · {et(g.start)}
                    </small>
                  </div>
                  {g.odds && <p className="small">{g.odds}</p>}
                  {g.moved && <p className="small">📈 {g.moved}</p>}
                  {g.injuries.length > 0 && (
                    <p className="small muted">
                      🩹 {g.injuries.map((i) => `${i.player} (${i.team}, ${i.status})`).join(', ')}
                    </p>
                  )}
                  <a className="small" href={g.url} target="_blank" rel="noreferrer">
                    ESPN game page
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">
          Paper research only: no guaranteed winners, and nothing here places a bet or touches your bets. Check the price and who's playing before
          you decide. {`Gambling problem? Call 1-800-GAMBLER.`}
        </p>
      </section>
    </ProGate>
  );
}

function AnalystCard({ c }: { c: AnalystPick }) {
  return (
    <article className="card analyst">
      <div className="row between">
        <b>{c.market}</b>
        <b>{fmtOdds(c.odds)}</b>
      </div>
      <small className="muted">
        {c.event} · {label(c.league)} · {et(c.start)} · {c.bookmaker}
        {c.onRecord && <span className="pill model">On the record</span>}
      </small>
      <div className="stats">
        <div className="stat">
          <small className="muted">Model</small>
          <b>{pct(c.probability)}</b>
        </div>
        <div className="stat">
          <small className="muted">Break-even</small>
          <b>{pct(c.breakEven)}</b>
        </div>
        <div className="stat">
          <small className="muted">Edge</small>
          <b className="pos">+{(c.edge * 100).toFixed(1)}</b>
        </div>
      </div>
      <p className="small">{c.method}</p>
      <p className="small">✅ {c.availability}</p>
      <p className="small">
        <b>Why it could lose</b>
      </p>
      <ul className="small">
        {c.counterarguments.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      <p className="small">
        <b>Pass if</b>
      </p>
      <ul className="small">
        {c.passIf.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      <details>
        <summary className="small">Sources ({c.evidence.length})</summary>
        <ul className="small">
          {c.evidence.map((e, i) => (
            <li key={i}>
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.note}
              </a>{' '}
              <span className="muted">· {et(e.checkedAt)}</span>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
