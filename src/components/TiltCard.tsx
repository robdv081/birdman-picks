import type { Bet } from '../bets';
import { HELPLINE } from '../guard';
import { useTilt } from '../tilt';

/** Shown on the Bets tab when the tilt detector notices something, and while a break is on. */
export default function TiltCard({ bets }: { bets: Bet[] }) {
  const t = useTilt(bets);
  if (t.onBreak)
    return (
      <div className="card tilt calm" role="status">
        <b>☕ You're on a break until {new Date(t.breakUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</b>
        <p className="muted small">
          Tracking new bets is paused on this device until then. Scores and your record still work. Talking to someone helps: {HELPLINE}, free and
          24/7.
        </p>
        <button className="linkbtn small" onClick={() => confirm('End your break early?') && t.endBreak()}>
          End break early
        </button>
      </div>
    );
  if (!t.signals.length) return null;
  return (
    <div className="card tilt" role="status">
      <b>Quick check-in</b>
      <ul className="small">
        {t.signals.map((s) => (
          <li key={s.key}>{s.text}</li>
        ))}
      </ul>
      <p className="muted small">Nothing's wrong with betting for fun. These are just the patterns that tend to come before a rough night. Want to take a break?</p>
      <div className="row wrap">
        <button className="btn sm" onClick={() => t.takeBreak(24)}>
          Take 24 hours off
        </button>
        <button className="btn ghost sm" onClick={() => t.takeBreak(7 * 24)}>
          Take a week off
        </button>
        <button className="btn ghost sm" onClick={t.snooze}>
          I'm fine
        </button>
      </div>
      <p className="muted small">
        Need to talk? Call {HELPLINE}, free and confidential, 24/7. You can also set a weekly limit in Settings on the Bets tab.
      </p>
    </div>
  );
}
