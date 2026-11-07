import { useEffect, useMemo, useRef, useState } from 'react';
import { newId } from '../bets';
import { loadDkSlates, projectSlate, slateFromCsv, SPORT_LABEL, type DfsPlayer, type Slate, type Sport } from '../dfs';
import { downloadFile, fileSlug, TEMPLATES, type Lineup } from '../fantasy';
import { uploadFileCsv, generate, type ContestStyle, type GenLineup } from '../generator';
import { RISK_LABEL } from '../optimizer';
import { saveSnapshot } from '../snapshots';

const money = (n: number) => `$${n.toLocaleString()}`;
const SPORTS: Sport[] = ['nfl', 'nba', 'nhl'];
const COUNTS = [1, 3, 5, 10, 20];
const EXPOSURES = [1, 0.75, 0.5, 0.33];

function slateName(s: Slate) {
  const when = s.start ? new Date(`${s.start}-05:00`).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  return `${SPORT_LABEL[s.sport]} · ${s.label}${s.games ? ` · ${s.games} games` : ''}${when ? ` · ${when}` : ''}`;
}

function ago(iso?: string) {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export default function Generator({ onSave }: { onSave: (l: Lineup) => void }) {
  const [site, setSite] = useState<'dk' | 'fd'>('dk');
  const [dk, setDk] = useState<{ updated?: string; slates: Slate[] } | null>(null);
  const [slateId, setSlateId] = useState('');
  // FanDuel: pasted list
  const [fdSport, setFdSport] = useState<Sport>('nfl');
  const fdTemplates = TEMPLATES.filter((t) => t.id.startsWith('fd-') && t.league === fdSport);
  const [fdTemplate, setFdTemplate] = useState('fd-nfl');
  const [fdText, setFdText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [players, setPlayers] = useState<DfsPlayer[] | null>(null);
  const [snapId, setSnapId] = useState<string | null>(null);
  const [slate, setSlate] = useState<Slate | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [style, setStyle] = useState<ContestStyle>('gpp');
  const [count, setCount] = useState(5);
  const [exposure, setExposure] = useState(0.75);
  const [avoidRisk, setAvoidRisk] = useState(true);
  const [stack, setStack] = useState(true);
  const [bringBack, setBringBack] = useState(true);
  const [noOpp, setNoOpp] = useState(true);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [lineups, setLineups] = useState<GenLineup[] | null>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [posFilter, setPosFilter] = useState('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadDkSlates().then((d) => {
      setDk(d);
      if (d.slates.length) setSlateId(d.slates[0].id);
    });
  }, []);

  useEffect(() => {
    if (!fdTemplates.some((t) => t.id === fdTemplate)) setFdTemplate(fdTemplates[0]?.id ?? '');
  }, [fdSport]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen: Slate | null = useMemo(() => {
    if (site === 'dk') return dk?.slates.find((s) => s.id === slateId) ?? null;
    const t = TEMPLATES.find((x) => x.id === fdTemplate);
    if (!t || !fdText.trim()) return null;
    const s = slateFromCsv(fdText, fdSport, 'fd', t.slots, t.cap);
    return s.players.length ? s : null;
  }, [site, dk, slateId, fdText, fdSport, fdTemplate]);

  const build = async () => {
    if (!chosen) return;
    setError(null);
    setLineups(null);
    setProgress('Starting…');
    try {
      const p = await projectSlate(chosen, setProgress);
      setPlayers(p);
      setSnapId(saveSnapshot(chosen, chosen.site === 'dk' ? `dk-${chosen.sport}` : fdTemplate, p));
      setSlate(chosen);
      setLocked(new Set());
      setExcluded(new Set());
      setPosFilter('All');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const run = async () => {
    if (!players || !slate) return;
    setError(null);
    setProgress('Building lineups…');
    try {
      const result = await generate(
        players,
        {
          sport: slate.sport,
          site: slate.site,
          slots: slate.slots,
          cap: slate.cap,
          style,
          count,
          maxExposure: exposure,
          locked,
          excluded,
          avoidRisk,
          stack,
          bringBack,
          noOpposingDefense: noOpp,
        },
        setProgress
      );
      setLineups(result);
      setSaved(new Set());
      if (!result.length) setError('No lineup fits these settings. Try fewer locks, a higher exposure limit, or turning off a rule.');
    } finally {
      setProgress(null);
    }
  };

  const templateId = slate ? (slate.site === 'dk' ? `dk-${slate.sport}` : fdTemplate) : '';

  const save = (l: GenLineup, i: number) => {
    if (!slate) return;
    onSave({
      id: newId(),
      title: `${slate.site === 'dk' ? 'DraftKings' : 'FanDuel'} ${SPORT_LABEL[slate.sport]} ${slate.label} #${i + 1}`,
      date: slate.start?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      templateId,
      cap: slate.cap,
      slots: l.slots.map((s) => ({ slot: s.slot, id: s.player.id, player: s.player.name, team: s.player.opp ? `${s.player.team} vs ${s.player.opp}` : s.player.team, salary: s.player.salary, points: null })),
      notes: `Generated (${style === 'gpp' ? 'tournament' : 'cash'}): projected ${l.proj.toFixed(1)}, ceiling ${l.ceiling.toFixed(1)}.`,
      projected: Math.round(l.proj * 10) / 10,
      slateId: snapId ?? undefined,
    });
    setSaved((prev) => new Set(prev).add(i));
  };

  const hasIds = !!slate && slate.players.length > 0 && slate.players.every((p) => p.id && !/^p\d+$/.test(p.id));

  const download = () => {
    if (!slate || !lineups) return;
    const siteName = slate.site === 'dk' ? 'draftkings' : 'fanduel';
    downloadFile(`${siteName}-${slate.sport}-${fileSlug(slate.label)}-lineups.csv`, uploadFileCsv(slate.slots, lineups));
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string, other?: [Set<string>, (s: Set<string>) => void]) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      if (other?.[0].has(key)) {
        const o = new Set(other[0]);
        o.delete(key);
        other[1](o);
      }
    }
    setter(next);
  };

  const exposureRows = useMemo(() => {
    if (!lineups?.length) return [];
    const c = new Map<string, { p: DfsPlayer; n: number }>();
    for (const l of lineups) for (const s of l.slots) c.set(s.player.key, { p: s.player, n: (c.get(s.player.key)?.n ?? 0) + 1 });
    return [...c.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  }, [lineups]);

  const positions = useMemo(() => (slate ? ['All', ...new Set(slate.slots.filter((s) => !['FLEX', 'UTIL', 'G/F', 'F/C', 'SUPERFLEX'].includes(s)))] : []), [slate]);
  const shown = useMemo(() => {
    if (!players) return [];
    const q = search.trim().toLowerCase();
    return players
      .filter((p) => !p.out || locked.has(p.key))
      .filter((p) => posFilter === 'All' || p.slots.includes(posFilter))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q))
      .slice(0, 80);
  }, [players, posFilter, search, locked]);

  const sport = slate?.sport ?? (site === 'dk' ? dk?.slates.find((s) => s.id === slateId)?.sport : fdSport);

  return (
    <section className="card generator">
      <div className="row between">
        <h2>Lineup generator</h2>
        <div className="seg" role="tablist" aria-label="Site">
          <button className={site === 'dk' ? 'on' : ''} onClick={() => setSite('dk')}>DraftKings</button>
          <button className={site === 'fd' ? 'on' : ''} onClick={() => setSite('fd')}>FanDuel</button>
        </div>
      </div>
      <p className="muted small">
        Projects every player from recent games and season averages, adjusts for each team's implied points from the betting lines,
        blends in player props where the books post them (NBA, NHL), drops injured players, then builds the best lineups under the cap.
      </p>

      {site === 'dk' ? (
        dk == null ? (
          <p className="muted small">Loading DraftKings slates…</p>
        ) : dk.slates.length ? (
          <div className="row">
            <label className="field grow">
              <span>Slate · salaries updated {ago(dk.updated)}</span>
              <select id="gen-slate" value={slateId} onChange={(e) => setSlateId(e.target.value)}>
                {SPORTS.map((sp) => {
                  const list = dk.slates.filter((s) => s.sport === sp);
                  return list.length ? (
                    <optgroup key={sp} label={SPORT_LABEL[sp]}>
                      {list.map((s) => (
                        <option key={s.id} value={s.id}>
                          {slateName(s)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </label>
          </div>
        ) : (
          <p className="warn small">
            No DraftKings slates loaded. They refresh every 30 minutes on the live site; on this computer, run <code>npm run salaries</code>.
          </p>
        )
      ) : (
        <>
          <div className="grid3">
            <label className="field">
              <span>Sport</span>
              <select id="gen-fd-sport" value={fdSport} onChange={(e) => setFdSport(e.target.value as Sport)}>
                {SPORTS.map((s) => (
                  <option key={s} value={s}>
                    {SPORT_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Contest</span>
              <select id="gen-fd-template" value={fdTemplate} onChange={(e) => setFdTemplate(e.target.value)}>
                {fdTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {money(t.cap)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>FanDuel player list</span>
            <textarea
              id="gen-fd-text"
              rows={3}
              value={fdText}
              onChange={(e) => setFdText(e.target.value)}
              placeholder="On FanDuel, open a contest, tap Download players list, then paste or upload the CSV here."
            />
          </label>
          <div className="row">
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>
              Upload CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setFdText(await f.text());
                e.target.value = '';
              }}
            />
            <span className="muted small">{chosen ? `${chosen.players.length} players read` : ''}</span>
          </div>
        </>
      )}

      <div className="row">
        <span className="spacer" />
        <button className="btn primary" disabled={!chosen || !!progress} onClick={build}>
          {progress && !players ? 'Projecting…' : players && slate === chosen ? 'Refresh projections' : 'Build projections'}
        </button>
      </div>

      {progress && <div className="empty">{progress}</div>}
      {error && <p className="warn small">{error}</p>}

      {players && slate && (
        <>
          <div className="genopts">
            <div className="field">
              <span>Contest type</span>
              <div className="seg">
                <button className={style === 'cash' ? 'on' : ''} onClick={() => setStyle('cash')} title="50/50s and double-ups: highest median, low risk">
                  Cash
                </button>
                <button className={style === 'gpp' ? 'on' : ''} onClick={() => setStyle('gpp')} title="Tournaments: chase upside and stacks">
                  Tournament
                </button>
              </div>
            </div>
            <div className="field">
              <span>Lineups</span>
              <div className="seg">
                {COUNTS.map((n) => (
                  <button key={n} className={n === count ? 'on' : ''} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {count > 1 && (
              <div className="field">
                <span>Max exposure</span>
                <div className="seg">
                  {EXPOSURES.map((x) => (
                    <button key={x} className={x === exposure ? 'on' : ''} onClick={() => setExposure(x)}>
                      {Math.round(x * 100)}%
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="genrules">
            <label className="check">
              <input id="gen-avoid" type="checkbox" checked={avoidRisk} onChange={(e) => setAvoidRisk(e.target.checked)} />
              Avoid rotation risk (low or swinging minutes, no props posted, backup goalies, doubtful)
            </label>
            {sport === 'nfl' && (
              <>
                <label className="check">
                  <input id="gen-stack" type="checkbox" checked={stack} onChange={(e) => setStack(e.target.checked)} />
                  Stack the QB with one of his receivers or tight ends
                </label>
                <label className="check">
                  <input id="gen-bring" type="checkbox" checked={bringBack} disabled={!stack} onChange={(e) => setBringBack(e.target.checked)} />
                  Bring one player back from the QB's opponent
                </label>
                <label className="check">
                  <input id="gen-noopp" type="checkbox" checked={noOpp} onChange={(e) => setNoOpp(e.target.checked)} />
                  Never play offense against your own defense
                </label>
              </>
            )}
            {sport === 'nhl' && (
              <>
                <label className="check">
                  <input id="gen-stack" type="checkbox" checked={stack} onChange={(e) => setStack(e.target.checked)} />
                  Stack two skaters from the same team
                </label>
                <label className="check">
                  <input id="gen-noopp" type="checkbox" checked={noOpp} onChange={(e) => setNoOpp(e.target.checked)} />
                  Never play skaters against your own goalie
                </label>
              </>
            )}
          </div>
          <div className="row">
            <span className="muted small">
              {locked.size ? `${locked.size} locked · ` : ''}
              {excluded.size ? `${excluded.size} skipped · ` : ''}
              {players.filter((p) => !p.out && p.proj > 0).length} players projected, {players.filter((p) => p.out).length} ruled out by injury
            </span>
            <span className="spacer" />
            <button className="btn primary" onClick={run} disabled={!!progress}>
              Generate {count > 1 ? `${count} lineups` : 'lineup'}
            </button>
          </div>

          {lineups && lineups.length > 0 && (
            <div className="genresults">
              <div className="row between">
                <b>
                  {lineups.length} lineup{lineups.length === 1 ? '' : 's'} · best {Math.max(...lineups.map((l) => l.proj)).toFixed(1)} pts
                </b>
                <div className="row">
                  {hasIds && (
                    <button className="btn" onClick={download}>
                      Download for {slate.site === 'dk' ? 'DraftKings' : 'FanDuel'} upload
                    </button>
                  )}
                  <button className="btn ghost" onClick={() => lineups.forEach((l, i) => !saved.has(i) && save(l, i))}>
                    Save all
                  </button>
                </div>
              </div>
              {hasIds && <UploadHelp site={slate.site} />}
              {!hasIds && slate.site === 'fd' && (
                <p className="muted small">This player list has no FanDuel player ids, so it can't make an upload file. Use FanDuel's own "Download players list" CSV.</p>
              )}
              {lineups.length < count && <p className="muted small">Only {lineups.length} distinct lineups fit these rules and exposure limits.</p>}
              <div className="genlist">
                {lineups.map((l, i) => (
                  <article key={i} className="card genlineup">
                    <header className="row between">
                      <div>
                        <small className="muted">Lineup {i + 1}</small>
                        <h3>{l.proj.toFixed(1)} pts</h3>
                      </div>
                      <div className="pstats">
                        <span>
                          <small>Ceiling</small>
                          <b>{l.ceiling.toFixed(0)}</b>
                        </span>
                        <span>
                          <small>Left</small>
                          <b>{money(slate.cap - l.salary)}</b>
                        </span>
                      </div>
                    </header>
                    <table className="slots ro">
                      <tbody>
                        {l.slots.map((s, j) => (
                          <tr key={j}>
                            <td className="slot">{s.slot}</td>
                            <td>
                              {s.player.name}
                              <small className="muted">
                                {' '}
                                {s.player.team}
                                {s.player.opp ? ` v ${s.player.opp}` : ''}
                              </small>
                              {s.player.risks.map((r) => (
                                <span key={r} className="pill pending flag">
                                  {RISK_LABEL[r]}
                                </span>
                              ))}
                            </td>
                            <td className="r">{money(s.player.salary)}</td>
                            <td className="r">{s.player.proj.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="actions">
                      <span className="spacer" />
                      <button className="btn ghost sm" disabled={saved.has(i)} onClick={() => save(l, i)}>
                        {saved.has(i) ? 'Saved' : 'Save to my lineups'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {lineups.length > 1 && (
                <div className="exposure">
                  <small className="muted">Most-used players</small>
                  <ul className="rlist">
                    {exposureRows.map(({ p, n }) => (
                      <li key={p.key}>
                        <span>
                          {p.name} <small className="muted">{p.team}</small>
                        </span>
                        <span className="hitbar wide">
                          <i style={{ width: `${(n / lineups.length) * 100}%` }} />
                        </span>
                        <b>{Math.round((n / lineups.length) * 100)}%</b>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {slate.site === 'dk' && (
                <p className="muted small">
                  To enter them all at once: on DraftKings, open the contest, choose Upload Lineups, and select the downloaded file.
                </p>
              )}
            </div>
          )}

          <div className="poolhead row between">
            <b>Player pool</b>
            <input id="gen-search" className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search player or team" />
          </div>
          <div className="chips small">
            {positions.map((p) => (
              <button key={p} className={`chip ${p === posFilter ? 'on' : ''}`} onClick={() => setPosFilter(p)}>
                {p}
              </button>
            ))}
          </div>
          <div className="tablewrap">
            <table className="box optpool">
              <thead>
                <tr>
                  <th className="pname">Player</th>
                  <th>Salary</th>
                  <th title="Median projection">Proj</th>
                  <th title="90th-percentile outcome">Ceil</th>
                  <th>Pts/$1K</th>
                  <th title="Team's implied points from the betting lines (defenses and goalies: the opponent's)">Vegas</th>
                  <th>Lock</th>
                  <th>Skip</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.key} className={excluded.has(p.key) ? 'dnp' : ''}>
                    <td className="pname" title={`Projection from ${p.source}`}>
                      {p.name}{' '}
                      <small>
                        {p.pos.join('/')} · {p.team}
                        {p.opp ? ` v ${p.opp}` : ''}
                      </small>
                      {p.risks.length > 0 && <small className="inj"> · {p.risks.map((r) => RISK_LABEL[r]).join(', ')}</small>}
                      {p.weather && <small className="inj"> · {p.weather}</small>}
                    </td>
                    <td>{money(p.salary)}</td>
                    <td>{p.proj.toFixed(1)}</td>
                    <td>{p.ceiling.toFixed(0)}</td>
                    <td>{((p.proj / p.salary) * 1000).toFixed(2)}</td>
                    <td>{p.implied ? p.implied.toFixed(1) : '—'}</td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Lock ${p.name}`}
                        checked={locked.has(p.key)}
                        onChange={() => toggle(locked, setLocked, p.key, [excluded, setExcluded])}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Skip ${p.name}`}
                        checked={excluded.has(p.key)}
                        onChange={() => toggle(excluded, setExcluded, p.key, [locked, setLocked])}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small disclaimer">
            Projections are estimates. Recent games and season averages don't know about late scratches or weather, so check final
            news before lock. NFL player props aren't published, so NFL projections use game logs and Vegas team totals only.
          </p>
        </>
      )}
    </section>
  );
}

/** How to get an upload file onto each site. */
export function UploadHelp({ site }: { site: 'dk' | 'fd' }) {
  return site === 'dk' ? (
    <p className="muted small">
      On DraftKings (computer browser): open the contest, enter it, then go to <b>My Contests → Upcoming → Upload Lineups</b> and pick this file. The
      phone app can't upload files.
    </p>
  ) : (
    <p className="muted small">
      On FanDuel (computer browser): open the contest, choose <b>Upload lineups</b> (or <b>Lineups → Upload</b>), and pick this file. It has to be the
      same contest whose player list you pasted, since the ids belong to that slate.
    </p>
  );
}
