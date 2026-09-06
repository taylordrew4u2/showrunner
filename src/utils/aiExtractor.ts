/**
 * AI-powered document parser for extracting show schedule data.
 * Calls the server-side proxy (/api/ai-extract), which holds the OpenAI key —
 * the key never ships in the client bundle. When the server has no key
 * configured the proxy returns 503 and every path falls back to on-device OCR /
 * deterministic local parsing.
 */

import type { ScheduleItem } from "../types";
import { generateId } from "./id";
import { api } from "./api";
import { borrowMeridiem, minutesBetweenClock, parseDurationSeconds } from "./showTiming";

interface AIScheduleRow {
  time?: string;
  description?: string;
  performer?: string;
  /** Minutes the segment runs, when the source said so. Never estimated. */
  durationMin?: number;
}

/** A whole positive number of minutes, or undefined. Anything a model can hand
 *  back that isn't one — a string, a fraction, a negative, a whole day — is not
 *  a cue length, and a bad one is worse than none: it would silently reshape
 *  the running order's timings. */
function cleanDuration(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const mins = Math.round(n);
  if (mins <= 0 || mins > 12 * 60) return undefined;
  return mins;
}

/**
 * How long a cue runs, when the row itself says so.
 *
 * The importer used to store no length at all, so every imported show opened
 * with "Cues timed 0/N" and a blank minutes field on every row — even when the
 * schedule it came from stated the length on the page. Read in order of how
 * explicit the source was: what the model returned, then a time range in the
 * text ("8:00–8:20"), then a stated duration ("15 min set").
 *
 * Nothing is invented. A row that doesn't say is left undefined, which is what
 * lets baseDurations keep inferring from the gap to the next cue.
 */
export function deriveDurationMin(
  fromModel: unknown,
  text: string | undefined,
  rangeEnd?: string,
  startTime?: string,
): number | undefined {
  const stated = cleanDuration(fromModel);
  if (stated) return stated;

  const span = minutesBetweenClock(startTime, rangeEnd);
  if (span) return span;

  const seconds = parseDurationSeconds(text);
  if (seconds != null && seconds > 0) return Math.max(1, Math.round(seconds / 60));
  return undefined;
}

/** Call the server proxy; returns mapped items (throws on any failure so callers can fall back). */
async function extractViaProxy(body: { mode: "text"; text: string } | { mode: "image"; image: string }): Promise<ScheduleItem[]> {
  const { items } = await api.post<{ items: AIScheduleRow[] }>("/api/ai-extract", body);
  if (!Array.isArray(items)) throw new Error("AI returned invalid format (not an array)");
  return items.map(mapAIItem);
}

function mapAIItem(item: AIScheduleRow): ScheduleItem {
  const time = item.time || "";
  // The model is asked for a start time, but it can hand back the whole range
  // in that field ("8:00-8:20"). Split it so the row keeps a clean start and
  // the span still becomes a length rather than being thrown away.
  const range = time.match(/^(.*?)\s*(?:[-–—]|to)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)$/i);
  // Same meridiem borrowing as the text parser: "8:00-8:20 PM" states the PM
  // once, at the end, and a bare "8:00" start reads as morning.
  const start = borrowMeridiem(range ? range[1].trim() : time, range?.[2]);
  return {
    id: generateId(),
    time: start,
    description: item.description || "",
    performer: item.performer || undefined,
    durationMin: deriveDurationMin(
      item.durationMin,
      `${item.description ?? ""} ${item.time ?? ""}`,
      range?.[2],
      start,
    ),
  };
}

/**
 * Extract text from PDF files using PDF.js
 */
async function extractTextFromPDF(file: File): Promise<string> {
  // Loaded on demand so pdfjs-dist (a large dependency) stays out of the main
  // bundle, and the legacy build to match the signing page — see
  // utils/pdfPages.ts for why that build. Shipping both would put two copies
  // of pdf.js and two workers, around 1.7 MB, into the deployed app.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    fullText += pageText + "\n";
  }

  return fullText.trim();
}

/**
 * Convert file to base64 data URL for image processing
 */
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Check if file is an image
 */
function isImageFile(file: File): boolean {
  return (
    file.type.includes("image") ||
    file.name.match(/\.(jpg|jpeg|png|gif|bmp|webp)$/i) !== null
  );
}

/**
 * Extract text from various file formats
 */
async function extractTextFromFile(file: File): Promise<string> {
  const fileType = file.type;

  // Handle text files
  if (
    fileType.includes("text") ||
    fileType.includes("json") ||
    file.name.endsWith(".csv")
  ) {
    return await file.text();
  }

  // Handle PDF files
  if (fileType.includes("pdf") || file.name.endsWith(".pdf")) {
    return await extractTextFromPDF(file);
  }

  // For images, return empty string (will be handled by vision API)
  if (isImageFile(file)) {
    return "";
  }

  // Try to read as text for other formats
  try {
    return await file.text();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read file format: ${fileType}. ${errorMsg}`);
  }
}

/**
 * Use AI vision (via the server proxy) to extract schedule items from an image.
 */
async function extractScheduleFromImage(file: File): Promise<ScheduleItem[]> {
  const base64Image = await fileToBase64(file);
  return extractViaProxy({ mode: "image", image: base64Image });
}

/**
 * Use AI (via the server proxy) to extract schedule items from text.
 */
async function extractScheduleWithAI(text: string): Promise<ScheduleItem[]> {
  return extractViaProxy({ mode: "text", text });
}

/**
 * Run on-device OCR on an image (lazy-loaded so it stays out of the main bundle).
 */
async function ocrImage(file: File): Promise<string> {
  const { recognize } = await import("tesseract.js");
  const { data } = await recognize(file, "eng");
  return data.text ?? "";
}

/**
 * Main function to import schedule from a file
 * Supports text files (.txt, .csv, .json), PDFs, and images (.jpg, .png, etc.)
 *
 * Every path is foolproof without AI: text/PDF fall back to deterministic local
 * parsing, and images fall back to on-device OCR (Tesseract) + local parsing.
 * AI is attempted first via the server proxy; if the server has no key
 * configured (503) or the call fails, we transparently fall back.
 */
export async function importScheduleFromFile(
  file: File,
): Promise<ScheduleItem[]> {
  // Images: try AI vision first, then on-device OCR.
  if (isImageFile(file)) {
    try {
      const aiItems = await extractScheduleFromImage(file);
      if (aiItems.length > 0) return aiItems;
    } catch (error) {
      // AI unavailable (no key / quota / network) — fall through to OCR.
      console.warn("AI vision failed, falling back to OCR:", error);
    }

    let ocrText = "";
    try {
      ocrText = await ocrImage(file);
    } catch (error) {
      console.error("OCR failed:", error);
    }
    const ocrItems = parseScheduleManually(ocrText);
    if (ocrItems.length > 0) return ocrItems;

    throw new Error(
      "Couldn't read a schedule from that photo. Make sure the times are clearly visible, or paste the text instead and add cues manually.",
    );
  }

  // Text / PDF: extract the text, try AI, then fall back to local parsing.
  const text = await extractTextFromFile(file);
  if (!text || text.trim().length === 0) {
    throw new Error("File is empty or contains no readable text.");
  }

  try {
    const aiItems = await extractScheduleWithAI(text);
    if (aiItems.length > 0) return aiItems;
  } catch (error) {
    // AI unavailable (no key / quota / network) — fall through to local parsing.
    console.warn("AI extraction failed, falling back to local parsing:", error);
  }

  const manualItems = parseScheduleManually(text);
  if (manualItems.length > 0) return manualItems;

  throw new Error(
    'No schedule lines found. Make sure the file has lines with times like "8:00 PM Welcome".',
  );
}

/**
 * Parse schedule from plain text manually (deterministic fallback, no AI).
 * Pulls a time and description from each line; handles 12h/24h formats, ranges
 * (8:00–8:20), times anywhere in the line, and leading bullets/separators.
 */
export function parseScheduleManually(text: string): ScheduleItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items: ScheduleItem[] = [];

  // "7:00 PM", "19:00", "7pm", "7 a.m." — a colon-time, or a bare hour with am/pm.
  const timePattern = /\b(\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)\b/i;

  for (const line of lines) {
    const match = line.match(timePattern);
    if (!match || match.index === undefined) continue;

    const time = match[1].replace(/\s+/g, " ").replace(/\.\s*/g, "").trim();
    let description = line.slice(0, match.index) + line.slice(match.index + match[0].length);

    // Take the range-end time out of the description ("8:00–8:20 PM Devon" →
    // after removing "8:00" → "–8:20 PM Devon" → "Devon"). Requires a real range
    // separator so a description that simply starts with a number (e.g. "5 min
    // break") is kept.
    //
    // It's captured rather than discarded: the end of the range is the one
    // place a plain-text schedule states how long a segment runs, and throwing
    // it away is why every imported cue arrived with no minutes on it.
    const rangeMatch = description.match(
      /^[\s•·*>]*(?:[-–—]|to)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)(?=\s|$)/i,
    );
    const rangeEnd = rangeMatch?.[1]?.replace(/\s+/g, " ").replace(/\.\s*/g, "").trim();
    if (rangeMatch) description = description.slice(rangeMatch[0].length);
    // Trim leading bullets/separators and trailing separators.
    description = description
      .replace(/^[\s\-–—:|•·*.>]+/, "")
      .replace(/[\s\-–—:|]+$/, "")
      .trim();

    if (description) {
      // A range writes the meridiem once, at the end, so the captured start of
      // "8:00-8:20 PM" is a bare "8:00" that reads as morning. Store it with
      // the meridiem it was always meant to have — otherwise the cue sorts and
      // times itself twelve hours out.
      const start = borrowMeridiem(time, rangeEnd);
      items.push({
        id: generateId(),
        time: start,
        description,
        durationMin: deriveDurationMin(undefined, description, rangeEnd, start),
      });
    }
  }

  return items;
}
