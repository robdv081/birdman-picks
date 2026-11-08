import { usePro } from '../pro';
import { disablePush, enablePush, followPick, setPickAlerts, usePush } from '../push';

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** Pro phone alerts: new Birdman picks, and line moves on picks you follow from the Record tab. */
export default function ProAlerts() {
  const pro = usePro();
  const push = usePush();
  if (!pro.enabled || !pro.pro) return null;

  if (!push.supported)
    return (
      <div className="card proalerts">
        <b>🔔 Pro alerts</b>
        <p className="muted small">
          {isIos && !installed
            ? 'On iPhone, add Birdman Picks to your Home Screen first (Share → Add to Home Screen), open it from there, then turn alerts on here.'
            : "This browser can't receive alerts. Try Chrome, Edge or Firefox, or the app on your Home Screen."}
        </p>
      </div>
    );

  return (
    <div className="card proalerts">
      <div className="row between">
        <b>🔔 Pro alerts {push.on && <span className="pill won">On</span>}</b>
        {push.on ? (
          <button className="btn ghost sm" disabled={push.busy} onClick={() => disablePush()}>
            Turn off
          </button>
        ) : (
          <button className="btn gold sm" disabled={push.busy} onClick={() => enablePush()}>
            {push.busy ? 'One sec…' : 'Turn on'}
          </button>
        )}
      </div>
      <p className="muted small">
        Alerts reach your phone even with the app closed: when a new Birdman pick is posted, when the line moves on a pick you follow (tap 🔔
        Follow line on any pending pick in the Record tab), and when a player in your open bets or fantasy lineups lands on the injury report.
        Prices and injuries are checked every 30 minutes.
      </p>
      {push.on && (
        <label className="small">
          <input type="checkbox" checked={push.picks} onChange={(e) => setPickAlerts(e.target.checked)} /> Alert me when a new pick is posted
        </label>
      )}
      {push.on && push.following.length > 0 && <p className="muted small">Following line moves on {push.following.length} pick(s).</p>}
      {push.error && <p className="warn small">{push.error}</p>}
    </div>
  );
}

/** The bell on a pending record pick. */
export function FollowButton({ pickId }: { pickId: string }) {
  const pro = usePro();
  const push = usePush();
  if (!pro.enabled || !pro.pro || !push.supported) return null;
  if (!push.on)
    return (
      <a className="linkbtn small" href="#scout">
        🔔 Alerts
      </a>
    );
  const on = push.following.includes(pickId);
  return (
    <button className={`btn sm ${on ? '' : 'ghost'}`} onClick={() => followPick(pickId, !on)}>
      {on ? '🔔 Following' : '🔔 Follow line'}
    </button>
  );
}
