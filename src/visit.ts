// Tells the Birdman server where this visit came from, once per browser session (see server/stats.ts).
// No cookies and nothing personal: just the source, the first page, the device type and whether this browser
// has been here before. Tagged links (?s=tiktok or utm_source=...) are the most reliable way to see which
// posts bring people in, because many apps (TikTok, Instagram) hide where a visitor came from.
import { api, serverReady } from './server';

const SEEN = 'bp.seen';
const SESSION = 'bp.visit';

/** Known referrers, so "l.instagram.com" and "www.instagram.com" count as one source. */
const SOURCES: [RegExp, string, string][] = [
  [/(^|\.)tiktok\.com$/, 'tiktok', 'social'],
  [/(^|\.)instagram\.com$/, 'instagram', 'social'],
  [/(^|\.)(facebook|fb)\.com$|^m\.me$/, 'facebook', 'social'],
  [/^t\.co$|(^|\.)(twitter|x)\.com$/, 'x', 'social'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'youtube', 'social'],
  [/(^|\.)reddit\.com$/, 'reddit', 'social'],
  [/(^|\.)discord(app)?\.com$|^discord\.gg$/, 'discord', 'social'],
  [/(^|\.)snapchat\.com$/, 'snapchat', 'social'],
  [/(^|\.)threads\.net$/, 'threads', 'social'],
  [/(^|\.)twitch\.tv$/, 'twitch', 'social'],
  [/(^|\.)linktr\.ee$/, 'linktree', 'referral'],
  [/(^|\.)google\.[a-z.]+$/, 'google', 'search'],
  [/(^|\.)bing\.com$/, 'bing', 'search'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo', 'search'],
  [/(^|\.)yahoo\.com$/, 'yahoo', 'search'],
];

const clean = (v: string | null) => (v ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

export function describeVisit(url: URL, referrer: string, ownHost: string) {
  const p = url.searchParams;
  let source = clean(p.get('utm_source') || p.get('s') || p.get('ref'));
  let medium = clean(p.get('utm_medium'));
  const campaign = clean(p.get('utm_campaign') || p.get('c')) || '-';
  if (source) medium ||= 'link';
  else if (referrer) {
    let host = '';
    try {
      host = new URL(referrer).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
    if (host && host !== ownHost) {
      const known = SOURCES.find(([re]) => re.test(host));
      source = known ? known[1] : clean(host);
      medium = known ? known[2] : 'referral';
    }
  }
  const landing = (url.hash.replace('#', '').split('/')[0] || 'today').toLowerCase();
  return { source: source || 'direct', medium: medium || 'none', campaign, landing };
}

function device(): string {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (standalone) return 'app';
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function trackVisit() {
  if (!serverReady() || !location.hostname.endsWith('github.io')) return;
  const url = new URL(location.href);
  if (url.hash.startsWith('#overlay')) return; // stream overlays reload all the time; they aren't visits
  try {
    if (sessionStorage.getItem(SESSION)) return;
    sessionStorage.setItem(SESSION, '1');
  } catch {
    /* private mode: count anyway */
  }
  let returning = false;
  try {
    returning = !!localStorage.getItem(SEEN);
    localStorage.setItem(SEEN, '1');
  } catch {
    /* ignore */
  }
  const v = describeVisit(url, document.referrer, location.hostname);
  api('/api/hit', { method: 'POST', body: { ...v, device: device(), returning } }).catch(() => {});
  // Tidy the address bar so shared links don't carry someone else's tag.
  const tags = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 's', 'c', 'ref'];
  if (tags.some((t) => url.searchParams.has(t))) {
    tags.forEach((t) => url.searchParams.delete(t));
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

/** Tagged links for the owner to post, so the Stats page shows which ones work. */
export function taggedLink(source: string, campaign = '') {
  const base = `${location.origin}${location.pathname}`;
  return `${base}?s=${encodeURIComponent(clean(source))}${campaign ? `&c=${encodeURIComponent(clean(campaign))}` : ''}`;
}
