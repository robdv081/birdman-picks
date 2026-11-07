// Visit and install counts via GoatCounter: no cookies and no personal data, only page counts.
// Dashboard: https://<GOATCOUNTER_CODE>.goatcounter.com

const GOATCOUNTER_CODE = 'birdmanpicks';

interface GoatCounter {
  no_onload?: boolean;
  count?: (o: { path: string; title?: string; event?: boolean }) => void;
}

declare global {
  interface Window {
    goatcounter?: GoatCounter;
  }
  interface Navigator {
    standalone?: boolean; // iOS Safari home-screen apps
  }
}

const INSTALL_FLAG = 'bp.installCounted';

function count(path: string, title?: string, event = false) {
  window.goatcounter?.count?.({ path, title, event });
}

function trackView() {
  const section = location.hash.replace('#', '') || 'today';
  count(`/${section}`, `Birdman Picks: ${section}`);
}

/**
 * iPhones don't report "Add to Home Screen", so an install is counted the first time this device opens
 * the app from its home-screen icon. Android's install prompt reports itself and counts the same way.
 */
function trackInstall(force = false) {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone && !force) return;
  try {
    if (localStorage.getItem(INSTALL_FLAG)) return;
    localStorage.setItem(INSTALL_FLAG, new Date().toISOString());
  } catch {
    return; // storage blocked: skip rather than count this device on every launch
  }
  count('installed', 'Installed (opened from home screen)', true);
}

export function initAnalytics() {
  // Only count the live site, never local development.
  if (!GOATCOUNTER_CODE || !location.hostname.endsWith('github.io')) return;
  window.goatcounter = { no_onload: true };
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  s.onload = () => {
    trackView();
    trackInstall();
  };
  document.head.appendChild(s);
  window.addEventListener('hashchange', trackView);
  window.addEventListener('appinstalled', () => trackInstall(true));
}
