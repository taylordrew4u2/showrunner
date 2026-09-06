import { describe, it, expect } from 'vitest';
import { pdfBytesFromDataUrl } from './pdfPages';

describe('pdfBytesFromDataUrl', () => {
  it('recovers the bytes a data URL carries', () => {
    const bytes = pdfBytesFromDataUrl(`data:application/pdf;base64,${btoa('%PDF-1.4')}`);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('%PDF-1.4');
  });

  it('handles bytes outside ASCII, which every real PDF has', () => {
    const raw = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80]);
    const base64 = btoa(String.fromCharCode(...raw));
    expect(Array.from(pdfBytesFromDataUrl(`data:application/pdf;base64,${base64}`)!)).toEqual(
      Array.from(raw),
    );
  });

  it('refuses anything that is not a base64 data URL', () => {
    expect(pdfBytesFromDataUrl('https://example.com/a.pdf')).toBeNull();
    expect(pdfBytesFromDataUrl('data:application/pdf,%25PDF')).toBeNull();
    expect(pdfBytesFromDataUrl('')).toBeNull();
  });

  it('returns null on damaged base64 rather than throwing mid-render', () => {
    expect(pdfBytesFromDataUrl('data:application/pdf;base64,!!!not base64!!!')).toBeNull();
  });
});
