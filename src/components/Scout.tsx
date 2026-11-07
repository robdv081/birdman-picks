import { useEffect, useState } from 'react';
import { api, serverReady } from '../server';
import { usePro } from '../pro';
import { load } from '../store';
import type { ScoutReport } from '../scout';
import { ProGate } from './Pro';
const et = (s: string) => new Date(s).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
export default function Scout() {
  const pro = usePro();
  const [report, setReport] = useState<ScoutReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true); setError('');
    try {
      const r = await api<{report: ScoutReport | null}>('/api/pro/scout', { headers: { Authorization: `Bearer ${load<string>('bp.pro.token', '')}` } });
      setReport(r.report);
    } catch(e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!pro.pro || !serverReady()) { setReport(null); return; }
    void refresh();
    // Every 5 minutes: each check makes the server re-verify schedules and the member's subscription.
    const timer = setInterval(() => !document.hidden && refresh(), 5 * 60_000);
    return () => clearInterval(timer);
  }, [pro.pro]);
  return <ProGate feature="Scout + Birdman Analyst" blurb="Verified research and selective paper candidates, with sources and clear pass conditions.">
    <section aria-label="Scout and Analyst">
      <h1>Scout + Birdman Analyst <span className="pill pro">Pro</span></h1>
      <p className="muted">Scout checks evidence. Analyst reviews independently estimated markets. No guaranteed winners.</p>
      {!serverReady() ? <p className="empty">Research service is not connected yet.</p> : <button className="btn" onClick={refresh} disabled={busy}>{busy ? 'Checking…' : 'Refresh research'}</button>}
      {error && <p role="alert" className="warn">{error}</p>}
      {report && <>
        <p>Checked {et(report.checkedAt)}</p>
        <div className="card"><b>{report.agents.scout}</b><p>{report.agents.analyst}</p>
        <p>{report.feeds.map(f => `${f.league.toUpperCase()}: ${f.events} events${f.stale ? ' • unavailable' : ''}`).join(' · ')}</p></div>
        {report.candidates.filter(c => Date.parse(c.start) > Date.now() + 600000).map(c => <article className="card" key={c.league+c.eventId}>
          <h2>{c.event}</h2><p>{et(c.start)} · {c.league.toUpperCase()}</p>
          <b>{c.market} · {c.odds > 0 ? '+' : ''}{c.odds} · {c.bookmaker}</b>
          <p>Break-even {(c.breakEven*100).toFixed(2)}% · Paper risk 1 unit</p>
          <p>Independent estimate: {((c.estimate?.probability ?? 0)*100).toFixed(2)}% — {c.estimate?.method}</p>
          <p>Validation: {c.estimate?.validation}</p>
          <p>Counterarguments: {c.counterarguments}</p><p>Pass if: {c.passIf}</p>
          <ul>{c.evidence.map((e,i) => <li key={i}><a href={e.url} target="_blank" rel="noreferrer">{e.note}</a> · {et(e.checkedAt)}</li>)}</ul>
        </article>)}
        {!report.candidates.length && <p className="empty">No verified picks. Evidence may be incomplete, stale, or below the selection requirements.</p>}
        {report.passes.length > 0 && <details><summary>Why markets were passed</summary><ul>{report.passes.map((p,i) => <li key={i}>{p.eventId}: {p.reason}</li>)}</ul></details>}
      </>}
      {!report && !busy && !error && serverReady() && <p className="empty">No research report published yet.</p>}
      <p className="muted small">Paper research only. Reports do not place bets or add entries to your ledger. Check current availability and prices before making any decision.</p>
    </section>
  </ProGate>;
}
