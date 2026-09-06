import { useEffect, useRef, useState } from 'react';
import type { SignatureRecord } from '../types';
import {
  collectFieldAnswers,
  fetchSigningDocument,
  fetchSigningRequest,
  missingRequiredFields,
  shortHash,
  signedFileName,
  submitSignature,
  type SigningPayload,
} from '../utils/contracts';
import { renderPdfPages, type RenderedPage } from '../utils/pdfPages';
import './SigningPage.css';

interface SigningPageProps {
  token: string;
  signKey: string | null;
}

type Phase = 'loading' | 'ready' | 'signing' | 'done' | 'missing' | 'nokey';

/**
 * The page a performer opens from a signing link.
 *
 * They have no account and will never make one, so everything here comes from
 * the link itself: the token addresses the row, and the key in the fragment
 * decrypts it. Nothing on this screen asks them to sign up, install anything,
 * or understand what a producer is — they read the document, type their name,
 * and are done.
 */
export function SigningPage({ token, signKey }: SigningPageProps) {
  const [phase, setPhase] = useState<Phase>(signKey ? 'loading' : 'nokey');
  const [payload, setPayload] = useState<SigningPayload | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  /**
   * The contract itself, drawn page by page.
   *
   * Not an `<object>` any more: iOS Safari will not render a PDF inline, so on
   * most phones the signer was shown a fallback button instead of the
   * agreement. Nobody should be asked to sign a document they were not shown.
   */
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [docError, setDocError] = useState(false);
  /** True once the last page has been scrolled past at least once. */
  const [readToEnd, setReadToEnd] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [signed, setSigned] = useState<SignatureRecord | null>(null);
  const [typedName, setTypedName] = useState('');
  // Keyed by field id, so editing the contract's questions later cannot
  // scramble what a signer typed.
  const [values, setValues] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signKey) return;
    let cancelled = false;
    (async () => {
      const view = await fetchSigningRequest(token, signKey);
      if (cancelled) return;
      if (!view) { setPhase('missing'); return; }
      setPayload(view.payload);
      setTypedName(view.payload.signerName);
      // What the show already answers — the date, the venue — arrives filled
      // in. It is an ordinary value in the field, so it can still be corrected.
      setValues(view.payload.prefill ?? {});
      const doc = await fetchSigningDocument(token, signKey, view.payload.total);
      if (cancelled) return;
      setDocUrl(doc);
      if (doc) {
        // Pages appear as they finish rather than all at the end — a long
        // agreement should be readable from page one while the rest draws.
        try {
          await renderPdfPages(doc, (page, total) => {
            if (cancelled) return;
            setPageCount(total);
            setPages((prev) => [...prev, page]);
          });
        } catch (err) {
          // Logged, not swallowed: when a signer says the document did not
          // show, this is the only place that can say why.
          console.error('Could not render the contract:', err);
          if (!cancelled) setDocError(true);
        }
      }
      if (view.signed) {
        setSigned(view.signed);
        setPhase('done');
      } else {
        setPhase('ready');
      }
    })();
    return () => { cancelled = true; };
  }, [token, signKey]);

  /**
   * Notice when the end of the document has been reached.
   *
   * Not a gate on signing — a signer who scrolls fast, or reads the copy they
   * were emailed, still gets to sign — but the page can then say plainly
   * whether there is more above the fold, which on a phone is otherwise
   * invisible.
   */
  useEffect(() => {
    const end = endRef.current;
    if (!end || pages.length === 0 || readToEnd) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setReadToEnd(true);
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [pages.length, readToEnd]);

  async function handleSign() {
    if (!signKey || !docUrl || !payload) return;
    const name = typedName.trim();
    const missing = missingRequiredFields(payload.fields, values);
    if (!name || !agreed || missing.length > 0) return;
    setPhase('signing');
    setError(null);
    try {
      const record = await submitSignature(
        token,
        signKey,
        name,
        docUrl,
        collectFieldAnswers(payload.fields, values),
      );
      setSigned(record);
      setPhase('done');
    } catch {
      setPhase('ready');
      setError(
        'That did not go through. Check your connection and try again — nothing has been signed yet.',
      );
    }
  }

  function download() {
    if (!docUrl || !payload) return;
    const a = document.createElement('a');
    a.href = docUrl;
    a.download = signedFileName(payload.contractName, signed?.typedName || payload.signerName);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (phase === 'nokey' || phase === 'missing') {
    return (
      <div className="signing signing--message">
        <div className="signing__card">
          <h1>This link will not open</h1>
          <p>
            {phase === 'nokey'
              ? 'Part of the link is missing — that usually happens when it is retyped by hand or trimmed by a messaging app. Ask for the link again and open it directly.'
              : 'It may have been withdrawn, or already replaced with a newer one. Ask whoever sent it for a fresh link.'}
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'loading' || !payload) {
    return (
      <div className="signing signing--message">
        <div className="signing__card"><p>Opening the document…</p></div>
      </div>
    );
  }

  return (
    <div className="signing">
      <header className="signing__bar">
        <span className="signing__from">{payload.fromName}</span>
        <h1 className="signing__title">{payload.contractName}</h1>
      </header>

      <main className="signing__main">
        {!docUrl ? (
          <p className="signing__error" role="alert">
            The document could not be loaded, so there is nothing to agree to yet. Reload the page,
            or ask for the link again.
          </p>
        ) : docError && pages.length === 0 ? (
          /* Drawing the pages failed — an encrypted or malformed PDF. The file
             itself is still here, so offer it rather than leaving them stuck. */
          <div className="signing__doc-fallback">
            <p>This document could not be displayed here.</p>
            <button className="btn btn--secondary" onClick={download}>Open the PDF</button>
          </div>
        ) : pages.length === 0 ? (
          <p className="signing__doc-loading">Opening the document…</p>
        ) : (
          <div className="signing__doc">
            {pages.map((page) => (
              <figure className="signing__page" key={page.pageNumber}>
                <img
                  src={page.dataUrl}
                  width={page.width}
                  height={page.height}
                  alt={`${payload.contractName}, page ${page.pageNumber} of ${pageCount}`}
                />
                {pageCount > 1 && (
                  <figcaption>
                    Page {page.pageNumber} of {pageCount}
                  </figcaption>
                )}
              </figure>
            ))}
            {pages.length < pageCount && (
              <p className="signing__doc-loading">
                Page {pages.length + 1} of {pageCount}…
              </p>
            )}
            <div ref={endRef} className="signing__doc-end" aria-hidden="true" />
          </div>
        )}
      </main>

      {phase === 'done' && signed ? (
        <section className="signing__panel signing__panel--done">
          <h2>Signed</h2>
          <p className="signing__done-line">
            {signed.typedName} · {new Date(signed.signedAt).toLocaleString()}
          </p>
          {signed.fields && signed.fields.length > 0 && (
            <dl className="signing__answers">
              {signed.fields.map((f) => (
                <div key={f.label} className="signing__answer">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="signing__ref">Document reference {shortHash(signed.documentHash)}</p>
          <button className="btn btn--primary signing__cta" onClick={download}>
            Save a copy
          </button>
          <p className="signing__note">
            {payload.fromName} can see that you have signed. Keep a copy for yourself — this
            link is the only place it lives.
          </p>
        </section>
      ) : (
        <section className="signing__panel">
          {error && <p className="signing__error" role="alert">{error}</p>}

          <label className="signing__field signing__field--name">
            <span>Your full name</span>
            <input
              type="text"
              value={typedName}
              autoComplete="name"
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Type your name"
            />
          </label>

          {(payload.fields ?? []).map((f) => (
            <label className="signing__field" key={f.id}>
              <span>
                {f.label}
                {!f.required && <em className="signing__optional"> optional</em>}
              </span>
              {f.multiline ? (
                <textarea
                  rows={3}
                  value={values[f.id] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                />
              ) : (
                <input
                  type="text"
                  value={values[f.id] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                />
              )}
            </label>
          ))}

          <label className="signing__agree">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              I have read this document and I agree to it. I understand that typing my name here
              is my signature.
            </span>
          </label>

          <button
            className="btn btn--primary signing__cta"
            disabled={
              !typedName.trim() ||
              !agreed ||
              !docUrl ||
              phase === 'signing' ||
              missingRequiredFields(payload.fields, values).length > 0
            }
            onClick={handleSign}
          >
            {phase === 'signing' ? 'Signing…' : 'Agree and sign'}
          </button>

          {missingRequiredFields(payload.fields, values).length > 0 && (
            <p className="signing__hint">
              Still needed: {missingRequiredFields(payload.fields, values).join(', ')}
            </p>
          )}

          {pages.length > 0 && !readToEnd && (
            <p className="signing__hint">
              {pageCount > 1
                ? `This agreement is ${pageCount} pages. Scroll up through all of it before you sign.`
                : 'Scroll up through the whole agreement before you sign.'}
            </p>
          )}

          <p className="signing__note">
            You can save your own copy once you have signed, or{' '}
            <button className="signing__link" onClick={download}>open the original PDF</button>.
            You will not need an account.
          </p>
        </section>
      )}
    </div>
  );
}
