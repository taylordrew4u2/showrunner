import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, SignatureRequest } from '../../types';
import {
  refreshSignatures,
  sendForSignature,
  shortHash,
  signingUrl,
  type ShowContext,
} from '../../utils/contracts';
import { rolodexKey } from '../../utils/rolodex';
import type { SessionCredentials } from '../../utils/session-vault';
import './PerformerContracts.css';

interface PerformerContractsProps {
  performerName: string;
  performerEmail?: string;
  settings: AppSettings;
  session: SessionCredentials;
  /** The booking this is being sent for, so date and venue arrive filled in. */
  show?: ShowContext;
  onUpdateSettings: (settings: AppSettings) => void;
}

const CAN_SHARE = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Contracts for one person, from inside the show they are booked on.
 *
 * The question a producer actually has on show week is "has this comic signed
 * yet?", and they ask it while looking at the comic — not in a separate
 * contracts screen sorted by document. So the whole of that lives here: send
 * them an agreement, see whether it came back, and see what they filled in.
 */
export function PerformerContracts({
  performerName,
  performerEmail,
  settings,
  session,
  show,
  onUpdateSettings,
}: PerformerContractsProps) {
  const contracts = useMemo(() => settings.contracts ?? [], [settings.contracts]);
  const requests = useMemo(() => settings.signatureRequests ?? [], [settings.signatureRequests]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Requests already sent to this person, whichever show they came from —
  // signing a performer agreement once is signing it.
  const key = rolodexKey(performerName);
  const theirs = useMemo(
    () => requests.filter((r) => rolodexKey(r.signerName) === key),
    [requests, key],
  );

  // Nobody tells the app when a link is signed, so the check happens when the
  // producer opens the person — which is when they came to ask.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const updated = await refreshSignatures(requests);
      if (!cancelled && updated) onUpdateSettings({ ...settings, signatureRequests: updated });
    })();
    return () => { cancelled = true; };
    // Mount only: finding a signature writes settings, which would re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function share(request: SignatureRequest) {
    const url = signingUrl(window.location.origin, request.token, request.key);
    try {
      if (CAN_SHARE) {
        await navigator.share({ title: request.contractName, text: `${request.contractName} to sign`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(request.token);
      setTimeout(() => setCopied((c) => (c === request.token ? null : c)), 2000);
    } catch {
      setError(url);
    }
  }

  async function send(contractId: string) {
    const contract = contracts.find((c) => c.id === contractId);
    const name = performerName.trim();
    if (!contract || !name) return;
    setError(null);
    setBusy(contractId);
    try {
      const request = await sendForSignature(
        contract,
        { name, email: performerEmail },
        settings.brandName,
        session,
        show,
      );
      onUpdateSettings({ ...settings, signatureRequests: [request, ...requests] });
      await share(request);
    } catch {
      setError('That did not send. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  const unsent = contracts.filter((c) => !theirs.some((r) => r.contractId === c.id));

  return (
    <div className="perf-contracts">
      <h3 className="perf-contracts__title">Contracts</h3>

      {error && <p className="perf-contracts__error" role="alert">{error}</p>}

      {contracts.length === 0 ? (
        <p className="perf-contracts__empty">
          No contracts yet. Add a PDF under More → Contracts, then send it from here.
        </p>
      ) : (
        <>
          {theirs.length > 0 && (
            <ul className="perf-contracts__list">
              {theirs.map((r) => (
                <li key={r.token} className="perf-contracts__row">
                  <span
                    className={`perf-contracts__mark${r.signed ? ' perf-contracts__mark--signed' : ''}`}
                    aria-hidden="true"
                  />
                  <div className="perf-contracts__who">
                    <span className="perf-contracts__name">{r.contractName}</span>
                    <span className="perf-contracts__meta">
                      {r.signed
                        ? `Signed ${fmtDate(r.signed.signedAt)} · ${shortHash(r.signed.documentHash)}`
                        : `Sent ${fmtDate(r.sentAt)} · not signed yet`}
                    </span>
                    {r.signed?.fields?.length ? (
                      <dl className="perf-contracts__answers">
                        {r.signed.fields.map((f) => (
                          <div key={f.label}>
                            <dt>{f.label}</dt>
                            <dd>{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                  {!r.signed && (
                    <button className="btn btn--ghost btn--sm" onClick={() => share(r)}>
                      {copied === r.token ? 'Copied' : CAN_SHARE ? 'Share' : 'Copy link'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {unsent.length > 0 && (
            <div className="perf-contracts__send">
              {unsent.map((c) => (
                <button
                  key={c.id}
                  className="btn btn--secondary btn--sm"
                  disabled={busy !== null || !performerName.trim()}
                  onClick={() => send(c.id)}
                >
                  {busy === c.id ? 'Sending…' : `Send ${c.name}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
