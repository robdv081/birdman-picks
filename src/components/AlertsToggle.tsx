import { useState } from 'react';
import { alertStatus, disableAlerts, enableAlerts, notify, type AlertSupport } from '../alerts';

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export default function AlertsToggle() {
  const [status, setStatus] = useState<AlertSupport>(alertStatus);

  if (status === 'unsupported')
    return (
      <p className="muted small alerts">
        {isIos && !installed
          ? 'Alerts on iPhone: add the app to your Home Screen first (Share → Add to Home Screen), then turn them on here.'
          : "This browser doesn't support alerts."}
      </p>
    );
  if (status === 'blocked')
    return <p className="muted small alerts">Alerts are blocked for this site. Allow notifications in your browser or phone settings to use them.</p>;

  return (
    <div className="row alerts">
      {status === 'on' ? (
        <>
          <span className="small">
            <span className="dot live" /> Alerts on: legs that hit, one leg away, busts and settled bets, while the app is open.
          </span>
          <button
            className="btn ghost sm"
            onClick={() => {
              disableAlerts();
              setStatus('off');
            }}
          >
            Turn off
          </button>
        </>
      ) : (
        <button
          className="btn sm"
          onClick={async () => {
            const s = await enableAlerts();
            setStatus(s);
            if (s === 'on') notify('Alerts are on', "You'll hear about your bets here while the app is open.", 'alerts-on');
          }}
        >
          Turn on bet alerts
        </button>
      )}
    </div>
  );
}
