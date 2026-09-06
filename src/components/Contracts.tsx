import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, Contract, ContractField, SignatureRequest } from '../types';
import {
  alreadyPending,
  contractNameFromFile,
  newContractField,
  refreshSignatures,
  requestsForContract,
  revokeSignature,
  sendForSignature,
  shortHash,
  signatureSummary,
  signingUrl,
  suggestedFields,
} from '../utils/contracts';
import { generateId } from '../utils/id';
import { uploadMedia, deleteMedia } from '../utils/mediaStore';
import { rolodexKey } from '../utils/rolodex';
import type { SessionCredentials } from '../utils/session-vault';
import { getRolodexTerm } from '../utils/terminology';
import { PageHeader } from './PageHeader';
import { useConfirm } from './useConfirm';
import './Contracts.css';

interface ContractsProps {
  settings: AppSettings;
  session: SessionCredentials;
  onBack: () => void;
  /** What the back control returns to. */
  backLabel?: string;
  onUpdateSettings: (settings: AppSettings) => void;
}

// A contract is a document, not a media library. Refused before the upload
// rather than after, so nobody waits through a long encrypt for a rejection.
const MAX_BYTES = 20 * 1024 * 1024;

// The share sheet is the natural way to hand someone a link on a phone, and
// absent on most desktop browsers. Checked once rather than at each call site.
const CAN_SHARE = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Contracts({ settings, session, onBack, backLabel = 'Shows', onUpdateSettings }: ContractsProps) {
  const { confirm, confirmDialog } = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const contracts = settings.contracts ?? [];
  const requests = useMemo(() => settings.signatureRequests ?? [], [settings.signatureRequests]);
  const rolodexTerm = getRolodexTerm(settings);

  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [manualName, setManualName] = useState('');
  const [editingFields, setEditingFields] = useState(false);

  const open = contracts.find((c) => c.id === openId) ?? null;
  const summary = signatureSummary(requests);

  /**
   * Look for signatures that landed while we were away.
   *
   * Nobody tells the app when a contract is signed — the signer's browser
   * writes to a row keyed by their token and walks off. So the one moment we
   * can reasonably check is when the producer opens this page, which is also
   * the moment they came here to ask the question.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const updated = await refreshSignatures(requests);
      if (!cancelled && updated) {
        onUpdateSettings({ ...settings, signatureRequests: updated });
      }
    })();
    return () => { cancelled = true; };
    // Deliberately on mount only: re-running on every settings write would
    // loop, since finding a signature writes settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') {
      setError('Contracts need to be PDFs. Export or print your document to PDF first.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That file is ${fmtSize(file.size)}. The limit is 20 MB.`);
      return;
    }
    setError(null);
    setBusy('upload');
    try {
      const fileRef = await uploadMedia(file);
      const contract: Contract = {
        id: generateId(),
        name: contractNameFromFile(file.name),
        fileRef,
        fileName: file.name,
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
        // A sensible starting list — most agreements want at least a stage
        // name and a credit line, and unwanted rows are one tap to remove.
        fields: suggestedFields(),
      };
      onUpdateSettings({ ...settings, contracts: [contract, ...contracts] });
    } catch {
      setError('That upload did not finish. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handleSend(name: string, email?: string, contactId?: string) {
    if (!open) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (alreadyPending(requests, open.id, trimmed)) {
      const go = await confirm({
        message: `${trimmed} already has an unsigned link for this contract. Sending again makes a second link, and whichever one they open first is the one that counts.`,
        confirmLabel: 'Send anyway',
        danger: false,
      });
      if (!go) return;
    }
    setError(null);
    setBusy(trimmed);
    try {
      const request = await sendForSignature(
        open,
        { name: trimmed, email, contactId },
        settings.brandName,
        session,
      );
      onUpdateSettings({ ...settings, signatureRequests: [request, ...requests] });
      setManualName('');
      setPicking(false);
      // Straight to the link — the producer's next move is always to send it.
      await copyLink(request);
    } catch {
      setError('That did not send. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(request: SignatureRequest) {
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
      // A cancelled share sheet is not a failure, and a blocked clipboard is
      // recoverable — show the link so it can be copied by hand.
      setError(url);
    }
  }

  async function handleRevoke(request: SignatureRequest) {
    const go = await confirm({
      message: request.signed
        ? `Delete the signed record for ${request.signerName}? The signature and the copy they agreed to are both removed, and this cannot be undone.`
        : `Withdraw ${request.signerName}'s link? It stops working straight away.`,
      confirmLabel: request.signed ? 'Delete record' : 'Withdraw',
      danger: true,
    });
    if (!go) return;
    try {
      await revokeSignature(request, session);
    } catch {
      // The row may already be gone; drop it locally regardless so the list
      // does not keep showing a link the producer has decided is dead.
    }
    onUpdateSettings({
      ...settings,
      signatureRequests: requests.filter((r) => r.token !== request.token),
    });
  }

  async function handleDeleteContract(contract: Contract) {
    const sent = requestsForContract(requests, contract.id);
    const go = await confirm({
      message: sent.length
        ? `Delete "${contract.name}"? ${sent.length} ${sent.length === 1 ? 'link' : 'links'} sent for it stop working, including any signatures on file.`
        : `Delete "${contract.name}"?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!go) return;
    for (const request of sent) {
      try { await revokeSignature(request, session); } catch { /* already gone */ }
    }
    deleteMedia(contract.fileRef);
    onUpdateSettings({
      ...settings,
      contracts: contracts.filter((c) => c.id !== contract.id),
      signatureRequests: requests.filter((r) => r.contractId !== contract.id),
    });
    setOpenId(null);
  }

  /** Save an edited question list onto the open contract. */
  function updateFields(contract: Contract, fields: ContractField[]) {
    onUpdateSettings({
      ...settings,
      contracts: contracts.map((c) => (c.id === contract.id ? { ...c, fields } : c)),
    });
  }

  // People from the Rolodex who have not already signed this one.
  const candidates = useMemo(() => {
    if (!open) return [];
    const done = new Set(
      requestsForContract(requests, open.id).map((r) => rolodexKey(r.signerName)),
    );
    return (settings.potentialComics ?? [])
      .filter((c) => c.name.trim() && !done.has(rolodexKey(c.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [open, requests, settings.potentialComics]);

  // ── One contract, opened ───────────────────────────────────────────────────
  if (open) {
    const sent = requestsForContract(requests, open.id);
    const openSummary = signatureSummary(sent);
    const openFields = open.fields ?? [];
    return (
      <div className="page contracts">
        <PageHeader
          title={open.name}
          subtitle={
            sent.length === 0
              ? 'Not sent to anyone yet'
              : `${openSummary.signed} of ${openSummary.total} signed`
          }
          onBack={() => { setOpenId(null); setPicking(false); setEditingFields(false); }}
          backLabel="Contracts"
        />

        {error && <p className="contracts__error" role="alert">{error}</p>}

        <div className="contracts__send">
          {!picking ? (
            <button className="btn btn--primary contracts__send-btn" onClick={() => setPicking(true)}>
              Send for signature
            </button>
          ) : (
            <div className="contracts__picker">
              <div className="contracts__picker-head">
                <h2>Who needs to sign it?</h2>
                <button className="btn btn--ghost btn--sm" onClick={() => setPicking(false)}>Done</button>
              </div>

              <div className="contracts__manual">
                <input
                  type="text"
                  value={manualName}
                  placeholder="Type a name"
                  onChange={(e) => setManualName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSend(manualName); }}
                />
                <button
                  className="btn btn--primary btn--sm"
                  disabled={!manualName.trim() || busy !== null}
                  onClick={() => handleSend(manualName)}
                >
                  Send
                </button>
              </div>

              {candidates.length > 0 && (
                <>
                  <p className="contracts__picker-label">From your {rolodexTerm.plural.toLowerCase()}</p>
                  <div className="contracts__candidates">
                    {candidates.map((c) => (
                      <button
                        key={c.id}
                        className="contracts__candidate"
                        disabled={busy !== null}
                        onClick={() => handleSend(c.name, c.email, c.id)}
                      >
                        <span className="contracts__candidate-name">{c.name}</span>
                        {busy === c.name.trim() ? (
                          <span className="contracts__candidate-hint">Sending…</span>
                        ) : (
                          <span className="contracts__candidate-hint">Send</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <section className="contracts__fields">
          <div className="contracts__fields-head">
            <h2 className="contracts__section-label">What the signer fills in</h2>
            <button className="btn btn--ghost btn--sm" onClick={() => setEditingFields((v) => !v)}>
              {editingFields ? 'Done' : 'Edit'}
            </button>
          </div>
          <p className="contracts__fields-note">
            Everyone is asked for their name. Add anything else this agreement needs — a stage
            name, how they want to be credited, a payout address. Changes apply to links you
            send from now on.
          </p>

          {editingFields ? (
            <>
              <div className="contracts__field-rows">
                {(openFields).map((f, i) => (
                  <div key={f.id} className="contracts__field-row">
                    <input
                      type="text"
                      value={f.label}
                      placeholder="What to ask for"
                      onChange={(e) =>
                        updateFields(
                          open,
                          openFields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                        )
                      }
                    />
                    <label className="contracts__field-toggle">
                      <input
                        type="checkbox"
                        checked={!!f.required}
                        onChange={(e) =>
                          updateFields(
                            open,
                            openFields.map((x, j) =>
                              j === i ? { ...x, required: e.target.checked } : x,
                            ),
                          )
                        }
                      />
                      <span>Required</span>
                    </label>
                    <label className="contracts__field-toggle">
                      <input
                        type="checkbox"
                        checked={!!f.multiline}
                        onChange={(e) =>
                          updateFields(
                            open,
                            openFields.map((x, j) =>
                              j === i ? { ...x, multiline: e.target.checked } : x,
                            ),
                          )
                        }
                      />
                      <span>Long answer</span>
                    </label>
                    <button
                      className="btn btn--ghost btn--sm"
                      aria-label={`Remove ${f.label || 'this question'}`}
                      onClick={() => updateFields(open, openFields.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => updateFields(open, [...openFields, newContractField()])}
              >
                Add a question
              </button>
            </>
          ) : openFields.length === 0 ? (
            <p className="contracts__fields-empty">Just their name and signature.</p>
          ) : (
            <ul className="contracts__field-list">
              {openFields.map((f) => (
                <li key={f.id}>
                  {f.label.trim() || 'Untitled question'}
                  {f.required && <span className="contracts__field-req"> · required</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {sent.length > 0 && (
          <section className="contracts__status">
            <h2 className="contracts__section-label">
              {openSummary.waiting > 0 ? `Waiting on ${openSummary.waiting}` : 'All signed'}
            </h2>
            <div className="contracts__rows">
              {sent.map((r) => (
                <div key={r.token} className="contracts__row">
                  <span
                    className={`contracts__mark${r.signed ? ' contracts__mark--signed' : ''}`}
                    aria-hidden="true"
                  />
                  <div className="contracts__row-who">
                    <span className="contracts__row-name">{r.signerName}</span>
                    <span className="contracts__row-meta">
                      {r.signed
                        ? `Signed ${fmtDate(r.signed.signedAt)} · ${shortHash(r.signed.documentHash)}`
                        : `Sent ${fmtDate(r.sentAt)}`}
                    </span>
                    {r.signed?.fields?.length ? (
                      <dl className="contracts__answers">
                        {r.signed.fields.map((f) => (
                          <div key={f.label} className="contracts__answer">
                            <dt>{f.label}</dt>
                            <dd>{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                  {!r.signed && (
                    <button className="btn btn--ghost btn--sm" onClick={() => copyLink(r)}>
                      {copied === r.token ? 'Copied' : CAN_SHARE ? 'Share' : 'Copy link'}
                    </button>
                  )}
                  <button className="btn btn--ghost btn--sm" onClick={() => handleRevoke(r)}>
                    {r.signed ? 'Delete' : 'Withdraw'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <button className="btn btn--ghost btn--sm contracts__delete" onClick={() => handleDeleteContract(open)}>
          Delete this contract
        </button>
        {confirmDialog}
      </div>
    );
  }

  // ── The library ────────────────────────────────────────────────────────────
  return (
    <div className="page contracts">
      <PageHeader
        title="Contracts"
        subtitle={
          summary.total === 0
            ? 'Agreements you send out to be signed'
            : `${summary.signed} signed · ${summary.waiting} waiting`
        }
        onBack={onBack}
        backLabel={backLabel}
        actions={
          <button
            className="btn btn--primary btn--sm"
            disabled={busy === 'upload'}
            onClick={() => fileInput.current?.click()}
          >
            {busy === 'upload' ? 'Adding…' : 'Add contract'}
          </button>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="contracts__file"
        onChange={handleUpload}
      />

      {error && <p className="contracts__error" role="alert">{error}</p>}

      {contracts.length === 0 ? (
        <p className="contracts__empty">
          Add a PDF — a performer agreement, a photo release — then send it to anyone in
          your {rolodexTerm.plural.toLowerCase()} to sign. You will see here who has and who has not.
        </p>
      ) : (
        <div className="contracts__list">
          {contracts.map((c) => {
            const s = signatureSummary(requestsForContract(requests, c.id));
            return (
              <button key={c.id} className="contracts__item" onClick={() => setOpenId(c.id)}>
                <div className="contracts__item-main">
                  <span className="contracts__item-name">{c.name}</span>
                  <span className="contracts__item-meta">
                    {s.total === 0
                      ? `${fmtSize(c.sizeBytes)} · not sent yet`
                      : `${s.signed} of ${s.total} signed`}
                  </span>
                </div>
                {s.waiting > 0 && <span className="contracts__badge">{s.waiting}</span>}
                <svg className="contracts__chevron" viewBox="0 0 8 13" aria-hidden="true">
                  <path d="M1.5 1.5 6 6.5 1.5 11.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
