import { useEffect, useState } from 'react';
import { api, ownerKey } from '../server';
import { taggedLink } from '../visit';

interface StatsData {
  days: number;
  from: string;
  daily: { day: string; visits: number; new: number }[];
  sources: { source: string; medium: string; visits: number; new: number }[];
  campaigns: { campaign: string; source: string; visits: number }[];
  landing: { landing: string; visits: number }[];
  devices: { device: string; visits: number }[];
  events: Record<string, number>;
}

const NAMES: Record<string, string> = {
  direct: 'Direct (typed it, a bookmark, or an app that hides links)',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X (Twitter)',
  youtube: 'YouTube',
  reddit: 'Reddit',
  discord: 'Discord',
  google: 'Google',
  bing: 'Bing',
  profile: 'Shared player profiles',
};
const DEVICES: Record<string, string> = { mobile: 'Phone browser', desktop: 'Computer', tablet: 'Tablet', app: 'Home-screen app', other: 'Other' };
const PRESETS = ['tiktok', 'instagram', 'x', 'youtube', 'discord', 'facebook'];

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** #stats — owner only: where visitors come from and what they do. */
export default function Stats() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<StatsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = ownerKey();

  useEffect(() => {
    if (!key) return;
    setErr(null);
    api<StatsData>(`/api/stats?days=${days}`, { headers: { Authorization: `Bearer ${key}` } }).then(setD, (e) => setErr((e as Error).message));
  }, [days, key]);

  if (!key)
    return (
      <section>
        <div className="hero">
          <h1>Stats</h1>
        </div>
        <div className="empty">
          Owner only. Sign in on the <a href="#record">Record</a> tab first.
        </div>
      </section>
    );

  const total = d?.daily.reduce((n, r) => n + r.visits, 0) ?? 0;
  const fresh = d?.daily.reduce((n, r) => n + r.new, 0) ?? 0;
  const peak = Math.max(1, ...(d?.daily.map((r) => r.visits) ?? [1]));
  const ev = d?.events ?? {};

  return (
    <section className="stats-page">
      <div className="hero">
        <p className="kicker">Owner only</p>
        <h1>Stats</h1>
        <p className="muted small">Visits counted once per browser session. No cookies, no IP addresses, no personal data, just daily totals.</p>
      </div>

      <div className="seg">
        {[7, 30, 90].map((n) => (
          <button key={n} className={n === days ? 'on' : ''} onClick={() => setDays(n)}>
            {n} days
          </button>
        ))}
      </div>

      {err && <div className="empty">{err}</div>}
      {!d && !err && <div className="empty">Loading…</div>}
      {d && (
        <>
          <div className="stats">
            <Box label="Visits" value={total} />
            <Box label="New visitors" value={fresh} />
            <Box label="Joined the contest" value={ev.player_created ?? 0} />
            <Box label="Contest picks" value={ev.player_pick ?? 0} />
            <Box label="Pro sign-ups" value={ev.pro_claim ?? 0} />
            <Box label="Alerts turned on" value={ev.alerts_on ?? 0} />
          </div>

          <div className="card">
            <b>Visits per day</b>
            {d.daily.length ? (
              <div className="daybars" role="img" aria-label="Visits per day">
                {d.daily.map((r) => (
                  <div key={r.day} className="daybar" title={`${r.day}: ${r.visits} visits, ${r.new} new`}>
                    <i style={{ height: `${(r.visits / peak) * 100}%` }} />
                    <small>{r.day.slice(5).replace('-', '/')}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No visits counted yet. They start showing up as people open the app.</p>
            )}
          </div>

          <Table
            title="Where they come from"
            note="Apps like TikTok and Instagram often hide where a visitor came from, so those show as Direct. Use the tagged links below to know for sure."
            head={['Source', 'Visits', 'New']}
            rows={d.sources.map((s) => [`${NAMES[s.source] ?? s.source}${s.medium !== 'none' && s.source !== 'direct' ? ` · ${s.medium}` : ''}`, s.visits, s.new])}
          />
          <Table title="Tagged links" head={['Tag', 'Visits']} rows={d.campaigns.map((c) => [`${NAMES[c.source] ?? c.source} · ${c.campaign}`, c.visits])} empty="No tagged-link visits yet." />
          <Table title="First page they saw" head={['Page', 'Visits']} rows={d.landing.map((l) => [l.landing, l.visits])} />
          <Table title="Devices" head={['Device', 'Visits']} rows={d.devices.map((x) => [DEVICES[x.device] ?? x.device, x.visits])} />
        </>
      )}

      <LinkMaker />
    </section>
  );
}

function Box({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b>{value.toLocaleString()}</b>
    </div>
  );
}

function Table({ title, note, head, rows, empty = 'Nothing yet.' }: { title: string; note?: string; head: string[]; rows: (string | number)[][]; empty?: string }) {
  return (
    <div className="card">
      <b>{title}</b>
      {note && <p className="muted small">{note}</p>}
      {rows.length ? (
        <table className="box statstable">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{typeof c === 'number' ? c.toLocaleString() : c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </div>
  );
}

function LinkMaker() {
  const [source, setSource] = useState('tiktok');
  const [campaign, setCampaign] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const link = taggedLink(source, campaign);
  return (
    <div className="card linkmaker">
      <b>🔗 Tagged links</b>
      <p className="muted small">
        Post these instead of the plain address, and the Stats page will show exactly which post brought each visitor. Add a tag like "bio" or
        "live" to tell posts apart.
      </p>
      <div className="chips small">
        {PRESETS.map((p) => (
          <button key={p} className={`chip ${p === source ? 'on' : ''}`} onClick={() => setSource(p)}>
            {NAMES[p] ?? p}
          </button>
        ))}
      </div>
      <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Tag (optional), e.g. bio, live, nov8" maxLength={40} />
      <p className="small">
        <code className="code">{link}</code>{' '}
        <button className="linkbtn small" onClick={async () => setNote((await copy(link)) ? 'Copied.' : 'Copy it by hand.')}>
          Copy
        </button>
      </p>
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
