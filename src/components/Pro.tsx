import { useState, type ReactNode } from 'react';
import { dismissThanks, manageBilling, restoreStart, restoreVerify, upgrade, usePro } from '../pro';

const PERKS = ['Prop parlay builder', 'Fantasy lineup generator', 'Best edges of the day', 'Full report card on your bets'];

/** Shows its children to Pro members; everyone else sees what the feature does and how to unlock it. */
export function ProGate({ feature, blurb, children }: { feature: string; blurb: string; children: ReactNode }) {
  const p = usePro();
  if (p.pro || !p.enabled) return <>{children}</>;
  if (!p.checked) return <div className="empty">Checking your Pro membership…</div>;
  return (
    <div className="card progate">
      <span className="pill pro">Pro</span>
      <h2>{feature}</h2>
      <p className="muted">{blurb}</p>
      <ul className="perks">
        {PERKS.map((x) => (
          <li key={x}>✓ {x}</li>
        ))}
      </ul>
      <button className="btn gold" onClick={upgrade}>
        Get Birdman Pro
      </button>
      <small className="muted">Monthly subscription through Stripe. Cancel anytime from the Pro card on My Bets.</small>
      <RestorePro />
    </div>
  );
}

/** Thank-you or problem note right after checkout. */
export function ProNotice() {
  const p = usePro();
  if (!p.justBought && !p.error) return null;
  return (
    <div className={`card pronotice ${p.error ? 'bad' : ''}`} role="status">
      <p>{p.error ?? "🎉 Welcome to Birdman Pro. Every Pro feature is unlocked on this device."}</p>
      <button className="btn ghost sm" onClick={dismissThanks}>
        OK
      </button>
    </div>
  );
}

/** Membership status, billing and restore, on the My Bets page. */
export function ProCard() {
  const p = usePro();
  const [msg, setMsg] = useState<string | null>(null);
  if (!p.enabled) return null;
  const renews = p.renews ? new Date(p.renews).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  return (
    <div className="card procard">
      <div className="row between">
        <b>
          Birdman Pro <span className={`pill ${p.pro ? 'won' : ''}`}>{p.pro ? 'Active' : 'Not active'}</span>
        </b>
        {p.pro ? (
          <button
            className="btn sm"
            onClick={() =>
              manageBilling().catch((e) => {
                setMsg((e as Error).message);
              })
            }
          >
            Manage billing
          </button>
        ) : (
          <button className="btn gold sm" onClick={upgrade}>
            Get Pro
          </button>
        )}
      </div>
      {p.pro && renews && (
        <p className="muted small">
          {p.cancelsAtPeriodEnd ? `Canceled. Pro stays on until ${renews}.` : `Renews ${renews}. Update your card or cancel under Manage billing.`}
        </p>
      )}
      {!p.pro && <RestorePro />}
      {msg && <p className="warn small">{msg}</p>}
    </div>
  );
}

/** New phone or cleared browser: get Pro back with the email used at checkout. */
function RestorePro() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open)
    return (
      <button className="linkbtn small" onClick={() => setOpen(true)}>
        Already Pro? Restore it on this device
      </button>
    );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="restore"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sent)
          run(async () => {
            setMsg(await restoreStart(email.trim()));
            setSent(true);
          });
        else run(() => restoreVerify(email.trim(), code.trim()));
      }}
    >
      <input type="email" autoComplete="email" placeholder="Email you paid with" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={sent} />
      {sent && <input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} required />}
      <button className="btn sm" disabled={busy}>
        {busy ? 'One sec…' : sent ? 'Restore Pro' : 'Email me a code'}
      </button>
      {msg && <small className="muted">{msg}</small>}
    </form>
  );
}
