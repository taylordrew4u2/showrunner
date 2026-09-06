/**
 * Render a PDF to images, page by page.
 *
 * The signing page used to hand the document to the browser in an `<object>`,
 * which works on a desktop and does nothing on an iPhone: iOS Safari refuses
 * to render a PDF inline, so most signers were shown a fallback button and a
 * document they had to take on trust. Somebody agreeing to a contract has to
 * be able to read it, all of it, on the device in their hand.
 *
 * So the pages are rendered here instead, with the same pdf.js the AI import
 * already uses, and shown as ordinary images the browser cannot refuse.
 */

/** One rendered page, ready to put in an <img>. */
export interface RenderedPage {
  /** 1-based, as the page is numbered to the reader. */
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Cap on the rendered width, in CSS pixels before the device ratio.
 *
 * Wide enough that small print stays legible zoomed in on a phone, and short
 * of the point where a long agreement's canvases exhaust memory on an older
 * one.
 */
const RENDER_WIDTH = 1100;

/** Pages beyond this are still rendered, just not all at once. See renderPdfPages. */
const MAX_PAGES = 60;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Pull the raw bytes out of a `data:application/pdf;base64,…` URL. */
export function pdfBytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.startsWith('data:')) return null;
  const meta = dataUrl.slice(5, comma);
  if (!meta.includes('base64')) return null;
  try {
    return base64ToBytes(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
}

/**
 * Render every page of a PDF given as a data URL.
 *
 * `onPage` is called as each page finishes rather than only at the end: a
 * twelve-page agreement takes a moment, and the reader should be able to start
 * on page one while page seven is still drawing.
 */
export async function renderPdfPages(
  dataUrl: string,
  onPage?: (page: RenderedPage, total: number) => void,
): Promise<RenderedPage[]> {
  const bytes = pdfBytesFromDataUrl(dataUrl);
  if (!bytes) throw new Error('That document could not be read.');

  // The legacy build, deliberately.
  //
  // pdf.js's modern build uses JavaScript only the newest browsers have —
  // `Map.prototype.getOrInsertComputed`, among others — and throws outright
  // anywhere else. The producer importing a schedule is on their own phone and
  // can update it; a signer is whoever the producer sent the link to, on
  // whatever phone they own, and gets one chance to read the agreement. The
  // legacy build is transpiled for exactly that.
  //
  // Loaded on demand either way: pdf.js is large, and nothing pays for it until
  // a document is actually being opened.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const total = Math.min(pdf.numPages, MAX_PAGES);
  const pages: RenderedPage[] = [];

  for (let n = 1; n <= total; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // Render above CSS size so the text survives pinch-zoom, which is how
    // anyone reads a contract's small print on a phone.
    const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    const viewport = page.getViewport({ scale: (RENDER_WIDTH / base.width) * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('That document could not be drawn.');
    // A PDF page is transparent where nothing is drawn, which on a dark theme
    // renders as white text on white paper. Paper is white.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;

    const rendered: RenderedPage = {
      pageNumber: n,
      // JPEG rather than PNG: a scanned agreement as PNG runs to tens of
      // megabytes of data URL, and this is a photograph of a page.
      dataUrl: canvas.toDataURL('image/jpeg', 0.82),
      width: canvas.width,
      height: canvas.height,
    };
    pages.push(rendered);
    onPage?.(rendered, total);
    // Let the canvas go before allocating the next one.
    canvas.width = 0;
    canvas.height = 0;
  }

  return pages;
}
