import type { Show } from '../types';
import { generateId } from './id';

/**
 * A copy of a show, ready to be a different night.
 *
 * One place, because there are two ways to make one — the Duplicate button and
 * booking a run of repeats — and they must agree about what belongs to the
 * show as a template (the lineup, the running order, the walk-on music) and
 * what belonged to that one night: its viewer link, the note pinned to it, and
 * the recap written afterwards. A copy carrying the original's viewer token
 * would publish over the original's live page.
 */
export function duplicateShow(original: Show, options: { name?: string; date?: string } = {}): Show {
  const now = new Date().toISOString();
  return {
    ...structuredClone(original),
    id: generateId(),
    name: options.name ?? `${original.name} (copy)`,
    status: 'upcoming',
    createdAt: now,
    updatedAt: now,
    // A repeat knows its date; a plain duplicate does not, and an empty date
    // is the app's prompt to pick one.
    date: options.date ?? '',
    viewToken: undefined,
    viewNote: undefined,
    recap: undefined,
  };
}
