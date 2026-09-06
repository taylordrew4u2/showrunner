import CryptoJS from 'crypto-js';
import type { Contract, ContractField, SignatureRecord, SignatureRequest } from '../types';
import { api } from './api';
import { decryptWithKey, encryptWithKey } from './encryption';
import { resolveMediaUrl } from './mediaStore';
import { rolodexKey } from './rolodex';
import { formatShowTime, parseShowDate } from './showDate';
import type { SessionCredentials } from './session-vault';

/**
 * Sending a contract out for signature.
 *
 * The person signing has no account and never gets one. They hold a link, and
 * that is the whole of their access. So the document, the covering details and
 * the signature they give back are all encrypted under a key generated for
 * that one request, which travels in the link's fragment (`#k=…`) and is
 * therefore never sent to any server. The backend stores ciphertext addressed
 * by an unguessable token, plus the bare fact of when a signature landed.
 *
 * This is the same arrangement the live viewer already uses for soundboard
 * audio; see api/sign.ts for the storage side.
 */

// Matches mediaStore: slice the data URL before encrypting so no single row is
// enormous.
const SLICE_CHARS = 1_500_000;

/** What the signer is shown, encrypted under the request key. */
export interface SigningPayload {
  contractName: string;
  signerName: string;
  /** The producer's brand name, so the signer knows who is asking. */
  fromName: string;
  fileName: string;
  /** Chunk count for the document in /api/sign-doc. */
  total: number;
  createdAt: string;
  /** Extra details this contract asks the signer to fill in. */
  fields?: ContractField[];
  /**
   * Answers already known, keyed by field id — the show's date, venue and
   * time when the contract was sent from a show. The signer sees them filled
   * in and can correct them; nothing here is locked.
   */
  prefill?: Record<string, string>;
}

/** What is known about the booking a contract is being sent for. */
export interface ShowContext {
  showName?: string;
  date?: string;
  time?: string;
  venueName?: string;
  location?: string;
}

/**
 * Fill in what the show already answers.
 *
 * A performer agreement that asks for the date and the venue is asking the
 * signer to retype what the producer sent them the link for. Matching is on
 * the label, since the questions are the producer's own words — "Venue",
 * "Where is it", "Show date" — rather than a fixed set.
 */
export function prefillFromShow(
  fields: ContractField[] | undefined,
  show: ShowContext | undefined,
): Record<string, string> {
  if (!fields?.length || !show) return {};
  const date = show.date ? (parseShowDate(show.date)?.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }) ?? show.date) : '';
  const time = formatShowTime(show.time) ?? '';
  const venue = [show.venueName, show.location].map((v) => (v ?? '').trim()).filter(Boolean).join(' — ');
  const out: Record<string, string> = {};
  for (const field of fields) {
    const label = field.label.toLowerCase();
    // Order matters: "show name" is asking for the show, not the venue, and
    // "date of birth" is not the show's date.
    if (/\bbirth|\bdob\b/.test(label)) continue;
    let value = '';
    if (/date|when\b/.test(label)) value = date;
    else if (/\btime\b|call time|set time|doors/.test(label)) value = time;
    else if (/venue|location|address|where/.test(label)) value = venue;
    else if (/show|event|production/.test(label)) value = (show.showName ?? '').trim();
    if (value) out[field.id] = value;
  }
  return out;
}

/**
 * The details most agreements ask for beyond a name.
 *
 * Offered as a starting point when a contract is first set up — a producer can
 * delete what does not apply, which is quicker than building the list from
 * nothing.
 */
export function suggestedFields(): ContractField[] {
  return [
    { id: 'stage-name', label: 'Stage name', placeholder: 'If different from your legal name' },
    { id: 'credit', label: 'How to credit you', placeholder: 'Name, pronouns, socials', multiline: true },
    { id: 'email', label: 'Email', required: true },
    { id: 'phone', label: 'Phone' },
    // These two answer themselves when the contract is sent from a show.
    { id: 'show-date', label: 'Show date' },
    { id: 'venue', label: 'Venue' },
  ];
}

/** A blank question, ready for the producer to name. */
export function newContractField(label = ''): ContractField {
  return { id: randomToken().slice(0, 10), label };
}

/**
 * The questions still unanswered that the signer cannot skip.
 *
 * Returned as labels rather than a boolean because the signer is told which
 * ones — "Fill in Email" beats a disabled button with no explanation.
 */
export function missingRequiredFields(
  fields: ContractField[] | undefined,
  values: Record<string, string>,
): string[] {
  return (fields ?? [])
    .filter((f) => f.required && !(values[f.id] ?? '').trim())
    .map((f) => f.label.trim() || 'a detail');
}

/**
 * What the signer typed, paired with the labels they saw and stripped of blanks
 * — an empty answer to an optional question is not worth recording.
 */
export function collectFieldAnswers(
  fields: ContractField[] | undefined,
  values: Record<string, string>,
): { label: string; value: string }[] {
  return (fields ?? [])
    .map((f) => ({ label: f.label.trim() || 'Detail', value: (values[f.id] ?? '').trim() }))
    .filter((f) => f.value !== '');
}

/** A 256-bit URL-safe token or key. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const generateSignToken = randomToken;
export const generateSignKey = randomToken;

export function splitIntoChunks(text: string, sliceChars = SLICE_CHARS): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += sliceChars) {
    chunks.push(text.slice(i, i + sliceChars));
  }
  return chunks;
}

/**
 * The signing link, with the key in the fragment.
 *
 * Everything after `#` stays in the browser — it is not in the request line and
 * not in Referer — so the key reaches the signer's JavaScript without ever
 * reaching the server holding the ciphertext.
 */
export function signingUrl(origin: string, token: string, key: string): string {
  return `${origin}/?sign=${encodeURIComponent(token)}#k=${key}`;
}

/** Read the key back out of a location fragment. */
export function readSignKeyFromHash(hash: string): string | null {
  const m = /[#&]k=([A-Za-z0-9_-]+)/.exec(hash || '');
  return m ? m[1] : null;
}

/**
 * A fingerprint of the exact bytes the signer was shown.
 *
 * Recorded with the signature so that the copy the producer keeps can be shown
 * to be the copy that was agreed to — the one question that actually matters if
 * an agreement is ever disputed.
 */
export function documentHash(dataUrl: string): string {
  return CryptoJS.SHA256(dataUrl).toString(CryptoJS.enc.Hex);
}

/** Short, human form of a hash, for showing on a receipt. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8).toUpperCase();
}

// ── Producer side ────────────────────────────────────────────────────────────

/**
 * Publish a contract for one signer and return the request to file in settings.
 *
 * The PDF is pulled out of the producer's own media store, re-encrypted under a
 * fresh key, and uploaded chunk by chunk.
 */
export async function sendForSignature(
  contract: Contract,
  signer: { name: string; email?: string; contactId?: string },
  fromName: string,
  creds: SessionCredentials,
  show?: ShowContext,
): Promise<SignatureRequest> {
  const dataUrl = await resolveMediaUrl(contract.fileRef);
  if (!dataUrl) throw new Error('That contract could not be opened.');

  const token = generateSignToken();
  const key = generateSignKey();
  const auth = { authUserId: creds.userId, authHash: creds.authHash };
  const chunks = splitIntoChunks(dataUrl);

  for (let seq = 0; seq < chunks.length; seq++) {
    await api.put(
      '/api/sign-doc',
      { token, seq, total: chunks.length, data: encryptWithKey(chunks[seq], key) },
      auth,
    );
  }

  const payload: SigningPayload = {
    contractName: contract.name,
    signerName: signer.name,
    fromName,
    fileName: contract.fileName,
    total: chunks.length,
    createdAt: new Date().toISOString(),
    fields: contract.fields?.length ? contract.fields : undefined,
    prefill: (() => {
      const filled = prefillFromShow(contract.fields, show);
      return Object.keys(filled).length ? filled : undefined;
    })(),
  };
  await api.put('/api/sign', { token, payload: encryptWithKey(payload, key) }, auth);

  return {
    id: token.slice(0, 12),
    token,
    key,
    contractId: contract.id,
    contractName: contract.name,
    contactId: signer.contactId,
    signerName: signer.name,
    signerEmail: signer.email,
    sentAt: new Date().toISOString(),
  };
}

/** Withdraw a request — the link stops working immediately. */
export async function revokeSignature(
  request: SignatureRequest,
  creds: SessionCredentials,
): Promise<void> {
  const auth = { authUserId: creds.userId, authHash: creds.authHash };
  await api.del(`/api/sign?token=${encodeURIComponent(request.token)}`, auth);
  await api.del(`/api/sign-doc?token=${encodeURIComponent(request.token)}`, auth);
}

/**
 * Check one outstanding request for a signature.
 *
 * Returns the record when it has been signed since we last looked, and null
 * otherwise — including when the check fails, because a request whose status we
 * could not read is not evidence that nobody signed it.
 */
export async function checkSignature(request: SignatureRequest): Promise<SignatureRecord | null> {
  if (request.signed) return null;
  try {
    const res = await api.get<{ signature: string | null; signedAt: string | null }>(
      `/api/sign?token=${encodeURIComponent(request.token)}`,
    );
    if (!res.signature) return null;
    const record = decryptWithKey<SignatureRecord>(res.signature, request.key);
    if (!record || typeof record.typedName !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Refresh every outstanding request, returning an updated list or null when
 * nothing changed. Null rather than a fresh copy because the caller writes the
 * whole encrypted settings blob on any change, and "still waiting" is by far
 * the common answer.
 */
export async function refreshSignatures(
  requests: SignatureRequest[],
): Promise<SignatureRequest[] | null> {
  const pending = requests.filter((r) => !r.signed);
  if (pending.length === 0) return null;
  const found = new Map<string, SignatureRecord>();
  for (const request of pending) {
    const record = await checkSignature(request);
    if (record) found.set(request.token, record);
  }
  if (found.size === 0) return null;
  return requests.map((r) => (found.has(r.token) ? { ...r, signed: found.get(r.token) } : r));
}

// ── Signer side ──────────────────────────────────────────────────────────────

export interface SigningView {
  payload: SigningPayload;
  signed: SignatureRecord | null;
}

/** Load a signing request by token, decrypting with the key from the link. */
export async function fetchSigningRequest(token: string, key: string): Promise<SigningView | null> {
  try {
    const res = await api.get<{ payload: string; signature: string | null }>(
      `/api/sign?token=${encodeURIComponent(token)}`,
    );
    const payload = decryptWithKey<SigningPayload>(res.payload, key);
    // A wrong key decrypts to nothing rather than throwing, so check the shape.
    if (!payload || typeof payload.contractName !== 'string') return null;
    const signed = res.signature ? decryptWithKey<SignatureRecord>(res.signature, key) : null;
    return { payload, signed: signed && signed.typedName ? signed : null };
  } catch {
    return null;
  }
}

/** Fetch and reassemble the contract PDF as a data URL. */
export async function fetchSigningDocument(
  token: string,
  key: string,
  total: number,
): Promise<string | null> {
  try {
    const parts: string[] = new Array(total);
    for (let seq = 0; seq < total; seq++) {
      const res = await api.get<{ data: string }>(
        `/api/sign-doc?token=${encodeURIComponent(token)}&seq=${seq}`,
      );
      parts[seq] = decryptWithKey<string>(res.data, key);
    }
    const joined = parts.join('');
    return joined.startsWith('data:') ? joined : null;
  } catch {
    return null;
  }
}

/** Submit the signature. The server accepts this once and refuses after. */
export async function submitSignature(
  token: string,
  key: string,
  typedName: string,
  documentDataUrl: string,
  fields: { label: string; value: string }[] = [],
): Promise<SignatureRecord> {
  const record: SignatureRecord = {
    signedAt: new Date().toISOString(),
    typedName: typedName.trim(),
    fields: fields.length ? fields : undefined,
    documentHash: documentHash(documentDataUrl),
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 200),
  };
  await api.post('/api/sign', { token, signature: encryptWithKey(record, key) });
  return record;
}

// ── Status, for the producer's list ──────────────────────────────────────────

export interface SignatureSummary {
  total: number;
  signed: number;
  waiting: number;
}

export function signatureSummary(requests: SignatureRequest[]): SignatureSummary {
  const signed = requests.filter((r) => r.signed).length;
  return { total: requests.length, signed, waiting: requests.length - signed };
}

/** Requests for one contract, newest first. */
export function requestsForContract(
  requests: SignatureRequest[],
  contractId: string,
): SignatureRequest[] {
  return requests
    .filter((r) => r.contractId === contractId)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

/**
 * Whether a name has already been sent this contract and not yet signed.
 * Sending the same person the same agreement twice produces two links, one of
 * which is dead the moment the other is signed — worth warning about.
 */
export function alreadyPending(
  requests: SignatureRequest[],
  contractId: string,
  signerName: string,
): boolean {
  // Normalised the same way the Rolodex matches people, so "Ada Cole" and
  // "Ada  cole" are one person here too.
  const key = rolodexKey(signerName);
  return requests.some(
    (r) => r.contractId === contractId && !r.signed && rolodexKey(r.signerName) === key,
  );
}

/**
 * A first guess at what to call an uploaded contract.
 *
 * Filenames arrive as `performer-agreement_v2.pdf`, and that is what the signer
 * sees at the top of the page they are being asked to agree to. Separators
 * become spaces; the producer's own capitalisation is left alone, since
 * title-casing would mangle names like "McKay" and initialisms like "W9".
 */
export function contractNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, '');
  const spaced = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || base || 'Contract';
}

/** A name for the signed copy the signer downloads. */
export function signedFileName(contractName: string, signerName: string): string {
  const safe = (s: string) => s.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  return `${safe(contractName)}-${safe(signerName)}.pdf`;
}
