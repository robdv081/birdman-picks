// Starts the GitHub jobs (pick agent, Scout) on time. GitHub's own timer often runs late or skips runs entirely
// when GitHub is busy, so the Worker's 5-minute cron, which runs on time, asks GitHub to start them instead.
// Needs GH_DISPATCH_TOKEN: a fine-grained GitHub token for this one repository with "Actions: read and write".
// Without it this does nothing and the workflows' own GitHub schedules are the only trigger.
import type { Env } from './util';

export interface Job {
  workflow: string;
  /** Eastern-time hours it runs in, and the 5-minute slot within the hour. */
  hours: number[];
  minutes: number[];
}

export const JOBS: Job[] = [
  // Pick agent: around noon, 5:15 and 7:15 PM Eastern (it posts at most 3 picks a day, so extra runs are harmless).
  { workflow: 'agent.yml', hours: [12, 17, 19], minutes: [15] },
  // Scout: every 30 minutes, 10 AM to midnight Eastern.
  { workflow: 'scout.yml', hours: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], minutes: [5, 35] },
];

function eastern(now: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: get('hour'), minute: get('minute') };
}

/** The jobs due in the 5-minute slot that contains `now`. */
export function dueJobs(now: number): string[] {
  const { hour, minute } = eastern(now);
  const slot = minute - (minute % 5);
  return JOBS.filter((j) => j.hours.includes(hour) && j.minutes.includes(slot)).map((j) => j.workflow);
}

export async function dispatchJobs(env: Env, now: number, send: typeof fetch = fetch) {
  if (!env.GH_DISPATCH_TOKEN) return { started: [] as string[], skipped: 'no token' };
  const repo = env.GH_REPO || 'robdv081/birdman-picks';
  const started: string[] = [];
  const failed: string[] = [];
  for (const wf of dueJobs(now)) {
    const res = await send(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'birdman-picks-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }).catch(() => null);
    if (res?.status === 204) started.push(wf);
    else failed.push(`${wf} (${res ? res.status : 'no response'})`);
  }
  return { started, failed };
}
