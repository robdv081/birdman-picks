import { useEffect, useState } from 'react';
import type { Selection } from '../bets';
import { BOOK_LABEL, copyText, dkTarget, fanduelUrl, slipText, type DkTarget } from '../books';

interface Props {
  picks: Selection[];
  title?: string;
}

/**
 * Hands picks to DraftKings or FanDuel. Links are worked out before the tap, because phones block
 * pop-ups that open after a network wait.
 */
export default function SendToBook({ picks, title }: Props) {
  const [open, setOpen] = useState<'dk' | 'fd' | null>(null);
  const [targets, setTargets] = useState<DkTarget[] | null>(null);
  const [copied, setCopied] = useState(false);
  const sig = picks.map((p) => `${p.eventId}|${p.market}|${p.side}|${p.line}|${p.dkLink ?? ''}`).join(';');

  useEffect(() => {
    if (open !== 'dk') return;
    let live = true;
    setTargets(null);
    Promise.all(picks.map(dkTarget)).then((t) => live && setTargets(t));
    return () => {
      live = false;
    };
  }, [open, sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = slipText(picks, title);
  const copy = async () => {
    setCopied(await copyText(text));
    setTimeout(() => setCopied(false), 2500);
  };
  const leagues = [...new Set(picks.map((p) => p.league))];
  const fdUrl = fanduelUrl(leagues.length === 1 ? leagues[0] : undefined);
  const multi = picks.length > 1;

  return (
    <div className="sendbook">
      <div className="row">
        <span className="muted small">Bet it at</span>
        <button type="button" className={`btn book dk ${open === 'dk' ? 'on' : ''}`} onClick={() => setOpen(open === 'dk' ? null : 'dk')}>
          {BOOK_LABEL.dk}
        </button>
        <button type="button" className={`btn book fd ${open === 'fd' ? 'on' : ''}`} onClick={() => setOpen(open === 'fd' ? null : 'fd')}>
          {BOOK_LABEL.fd}
        </button>
      </div>

      {open === 'dk' && (
        <div className="sendpanel">
          {!targets && <p className="muted small">Finding the DraftKings lines…</p>}
          {targets && (
            <>
              <p className="small">
                {multi
                  ? 'Tap each pick. DraftKings adds it to your bet slip and keeps it there while you come back for the next one.'
                  : targets[0].exact
                    ? 'Opens DraftKings with this pick on your bet slip.'
                    : "DraftKings has no direct link for this pick, so it opens the game. Find it there."}
              </p>
              <ul className="sendlist">
                {picks.map((p, i) => (
                  <li key={i}>
                    <a className="btn" href={targets[i].url} target="_blank" rel="noopener noreferrer">
                      {multi ? `${i + 1}. ` : ''}
                      {targets[i].exact ? 'Add to slip' : 'Open game'}
                    </a>
                    <span className="small">{p.selection}</span>
                  </li>
                ))}
              </ul>
              {targets.some((t) => !t.exact) && (
                <p className="muted small">"Open game" means the line moved or the pick is a prop, so DraftKings can't take it straight to the slip.</p>
              )}
              <p className="muted small">Check the price on DraftKings before you place it; lines move.</p>
            </>
          )}
        </div>
      )}

      {open === 'fd' && (
        <div className="sendpanel">
          <p className="small">
            FanDuel doesn't accept picks from other apps, so copy {multi ? 'them' : 'it'} and open FanDuel to add {multi ? 'each one' : 'it'} to your slip.
          </p>
          <pre className="picktext">{text}</pre>
          <div className="row">
            <button type="button" className="btn" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy picks'}
            </button>
            <a className="btn primary" href={fdUrl} target="_blank" rel="noopener noreferrer" onClick={() => void copyText(text)}>
              Open FanDuel
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
