import { describe, it, expect } from 'vitest';
import {
  alreadyPending,
  collectFieldAnswers,
  contractNameFromFile,
  documentHash,
  generateSignKey,
  generateSignToken,
  missingRequiredFields,
  newContractField,
  prefillFromShow,
  readSignKeyFromHash,
  requestsForContract,
  shortHash,
  signatureSummary,
  signerStatus,
  signedFileName,
  signingUrl,
  splitIntoChunks,
  suggestedFields,
} from './contracts';
import type { SignatureRequest } from '../types';

const req = (over: Partial<SignatureRequest>): SignatureRequest => ({
  id: 'r', token: 't', key: 'k', contractId: 'c1', contractName: 'Agreement',
  signerName: '', sentAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('generateSignToken', () => {
  it('is URL-safe, so it survives being pasted into a link', () => {
    expect(generateSignToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat — the token is the whole of the access control', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSignToken()));
    expect(seen.size).toBe(200);
  });

  it('carries a full 256 bits', () => {
    expect(generateSignKey().length).toBeGreaterThanOrEqual(42);
  });
});

describe('signingUrl', () => {
  it('puts the key in the fragment, never the query', () => {
    const url = signingUrl('https://example.com', 'TOK', 'KEY');
    expect(url).toBe('https://example.com/?sign=TOK#k=KEY');
    expect(url.split('#')[0]).not.toContain('KEY');
  });

  it('round-trips through the hash reader', () => {
    const key = generateSignKey();
    const url = signingUrl('https://example.com', 'TOK', key);
    expect(readSignKeyFromHash('#' + url.split('#')[1])).toBe(key);
  });

  it('escapes a token so it cannot break out of the query', () => {
    expect(signingUrl('https://e.com', 'a&b=c', 'K')).toContain('sign=a%26b%3Dc');
  });
});

describe('readSignKeyFromHash', () => {
  it('returns null when the link was shared without its fragment', () => {
    expect(readSignKeyFromHash('')).toBeNull();
    expect(readSignKeyFromHash('#')).toBeNull();
  });

  it('finds the key when other fragment params come first', () => {
    expect(readSignKeyFromHash('#a=1&k=ABC')).toBe('ABC');
  });
});

describe('documentHash', () => {
  it('is stable for the same bytes', () => {
    expect(documentHash('data:application/pdf;base64,AAA')).toBe(
      documentHash('data:application/pdf;base64,AAA'),
    );
  });

  it('changes when a single byte of the document changes', () => {
    expect(documentHash('data:application/pdf;base64,AAA')).not.toBe(
      documentHash('data:application/pdf;base64,AAB'),
    );
  });

  it('shortens to something a person can read off a receipt', () => {
    expect(shortHash(documentHash('x'))).toMatch(/^[0-9A-F]{8}$/);
  });
});

describe('splitIntoChunks', () => {
  it('rebuilds the original exactly', () => {
    const text = 'abcdefghij';
    expect(splitIntoChunks(text, 3).join('')).toBe(text);
  });

  it('leaves a short document in one piece', () => {
    expect(splitIntoChunks('abc', 10)).toEqual(['abc']);
  });
});

describe('signatureSummary', () => {
  it('counts who has signed and who has not', () => {
    const summary = signatureSummary([
      req({ token: 'a', signed: { signedAt: 'x', typedName: 'A', documentHash: 'h' } }),
      req({ token: 'b' }),
      req({ token: 'c' }),
    ]);
    expect(summary).toEqual({ total: 3, signed: 1, waiting: 2 });
  });

  it('handles nothing sent yet', () => {
    expect(signatureSummary([])).toEqual({ total: 0, signed: 0, waiting: 0 });
  });
});

describe('requestsForContract', () => {
  it('keeps only this contract, newest first', () => {
    const list = requestsForContract(
      [
        req({ token: 'old', sentAt: '2026-01-01T00:00:00.000Z' }),
        req({ token: 'other', contractId: 'c2' }),
        req({ token: 'new', sentAt: '2026-06-01T00:00:00.000Z' }),
      ],
      'c1',
    );
    expect(list.map((r) => r.token)).toEqual(['new', 'old']);
  });
});

describe('alreadyPending', () => {
  const outstanding = [req({ signerName: 'Ada Cole' })];

  it('spots a second send to someone who has not signed yet', () => {
    expect(alreadyPending(outstanding, 'c1', 'Ada Cole')).toBe(true);
  });

  it('matches the way the Rolodex matches people, not byte-for-byte', () => {
    expect(alreadyPending(outstanding, 'c1', '  ada   cole ')).toBe(true);
  });

  it('does not warn once they have signed', () => {
    const signed = [req({ signerName: 'Ada Cole', signed: { signedAt: 'x', typedName: 'Ada Cole', documentHash: 'h' } })];
    expect(alreadyPending(signed, 'c1', 'Ada Cole')).toBe(false);
  });

  it('does not warn about a different contract', () => {
    expect(alreadyPending(outstanding, 'c2', 'Ada Cole')).toBe(false);
  });
});

describe('contractNameFromFile', () => {
  it('reads a filename back as words', () => {
    expect(contractNameFromFile('performer-agreement.pdf')).toBe('performer agreement');
    expect(contractNameFromFile('Photo_Release_2026.PDF')).toBe('Photo Release 2026');
  });

  it('leaves capitalisation alone, so names and initialisms survive', () => {
    expect(contractNameFromFile('McKay-W9.pdf')).toBe('McKay W9');
  });

  it('always returns something to show', () => {
    expect(contractNameFromFile('.pdf')).toBe('Contract');
  });
});

describe('signedFileName', () => {
  it('is safe to write to a filesystem', () => {
    expect(signedFileName('Performer Agreement', 'Ada Cole')).toBe(
      'Performer-Agreement-Ada-Cole.pdf',
    );
  });

  it('drops punctuation a download would choke on', () => {
    expect(signedFileName('Release / Waiver', 'D\'Arcy')).toBe('Release-Waiver-DArcy.pdf');
  });
});


describe('contract fields', () => {
  const fields = [
    { id: 'stage', label: 'Stage name' },
    { id: 'credit', label: 'How to credit you', required: true, multiline: true },
  ];

  it('names the required questions still blank, so the signer is told which', () => {
    expect(missingRequiredFields(fields, { stage: 'Ada' })).toEqual(['How to credit you']);
    expect(missingRequiredFields(fields, { credit: 'Ada Cole (she/her)' })).toEqual([]);
  });

  it('treats whitespace as blank — a space is not an answer', () => {
    expect(missingRequiredFields(fields, { credit: '   ' })).toEqual(['How to credit you']);
  });

  it('has nothing to require when a contract asks for nothing', () => {
    expect(missingRequiredFields(undefined, {})).toEqual([]);
    expect(collectFieldAnswers(undefined, {})).toEqual([]);
  });

  it('records answers against the label the signer saw, trimmed', () => {
    expect(collectFieldAnswers(fields, { stage: ' Lady A ', credit: 'Lady A' })).toEqual([
      { label: 'Stage name', value: 'Lady A' },
      { label: 'How to credit you', value: 'Lady A' },
    ]);
  });

  it('drops unanswered optional questions rather than filing empty rows', () => {
    expect(collectFieldAnswers(fields, { credit: 'Lady A' })).toEqual([
      { label: 'How to credit you', value: 'Lady A' },
    ]);
  });

  it('gives each new question its own id, so two blank rows stay distinct', () => {
    expect(newContractField().id).not.toBe(newContractField().id);
  });

  it('suggests a starting list that is all editable text', () => {
    const suggested = suggestedFields();
    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested.every((f) => f.label.trim().length > 0)).toBe(true);
    expect(new Set(suggested.map((f) => f.id)).size).toBe(suggested.length);
  });
});


describe('prefillFromShow', () => {
  const show = {
    showName: 'Late Night Laughs',
    date: '2026-03-14',
    time: '20:30',
    venueName: 'The Basement',
    location: 'Portland, OR',
  };
  const f = (id: string, label: string) => ({ id, label });

  it('answers the questions the show already answers', () => {
    const filled = prefillFromShow(
      [f('d', 'Show date'), f('v', 'Venue'), f('t', 'Set time'), f('n', 'Show name')],
      show,
    );
    expect(filled.d).toContain('2026');
    expect(filled.v).toBe('The Basement — Portland, OR');
    expect(filled.t).toBeTruthy();
    expect(filled.n).toBe('Late Night Laughs');
  });

  it('leaves questions about the signer alone', () => {
    expect(prefillFromShow([f('s', 'Stage name'), f('c', 'How to credit you')], show)).toEqual({});
  });

  it('does not mistake a date of birth for the show date', () => {
    expect(prefillFromShow([f('b', 'Date of birth')], show)).toEqual({});
  });

  it('fills nothing when there is no show, and nothing from an empty show', () => {
    expect(prefillFromShow([f('d', 'Show date')], undefined)).toEqual({});
    expect(prefillFromShow([f('d', 'Show date'), f('v', 'Venue')], {})).toEqual({});
  });
});

describe('signerStatus', () => {
  const signed = { signedAt: '2026-03-01T00:00:00.000Z', typedName: 'Ada', documentHash: 'h' };

  it('says nothing about someone who was never sent anything', () => {
    expect(signerStatus([], 'Ada Cole')).toBeNull();
    expect(signerStatus([req({ signerName: 'Someone Else' })], 'Ada Cole')).toBeNull();
  });

  it('is green only when nothing is outstanding', () => {
    const one = req({ signerName: 'Ada Cole', signed });
    const two = req({ token: 't2', signerName: 'Ada Cole' });
    expect(signerStatus([one], 'Ada Cole')).toBe('signed');
    expect(signerStatus([one, two], 'Ada Cole')).toBe('waiting');
  });

  it('matches the way the Rolodex matches people, not by exact spelling', () => {
    expect(signerStatus([req({ signerName: 'Ada  COLE', signed })], 'ada cole')).toBe('signed');
  });
});
