import type { DeletedItem, Show } from '../types';

/**
 * Reconcile this device's held copy with what the account actually holds.
 *
 * A save that fails parks the whole show list in localStorage, and the next
 * launch used to prefer that copy outright — the entire list, replacing the
 * server's. That is right for the shows the device actually edited and wrong
 * for everything else: a phone that failed to save in a venue at 8pm, opened
 * again at 11pm, would push its 8pm picture of the account back over the
 * server and delete a show added from a laptop at 9pm. The app reported
 * "Saved", because from its side the save succeeded — it just saved the wrong
 * set. That is the "it said saved and the show is gone" case.
 *
 * So the held copy no longer speaks for shows it never touched:
 *
 * - In both places → the newer `updatedAt` wins, which is the edit the user
 *   made last whichever device made it.
 * - Only on the server → kept. The held copy predates it and cannot be
 *   evidence that it was deleted…
 * - …unless the trash says it was. A deletion is recorded there, so a show
 *   the user genuinely deleted stays deleted rather than resurrecting.
 * - Only in the held copy → kept. That is the unsaved work this whole
 *   mechanism exists to protect.
 */
export function mergePendingShows(
  pending: Show[],
  server: Show[],
  trash: DeletedItem[] = [],
): Show[] {
  const deleted = new Set(
    trash.filter((item) => item?.type === 'show' && item.data?.id).map((item) => item.data.id),
  );
  const held = new Map(pending.filter((show) => show?.id).map((show) => [show.id, show]));
  const merged: Show[] = [];

  for (const show of server) {
    if (!show?.id) continue;
    const local = held.get(show.id);
    if (!local) {
      // Deliberately deleted on this device, and the deletion is on record.
      if (!deleted.has(show.id)) merged.push(show);
      continue;
    }
    merged.push(newer(local, show));
    held.delete(show.id);
  }

  // Whatever the held copy has that the server has never seen — new shows made
  // while the save was failing. They lead, the way a new show does in the list.
  return [...held.values(), ...merged];
}

/**
 * The later of two versions of one show.
 *
 * A missing or unparseable `updatedAt` loses to a real one, and two shows
 * with neither fall back to the held copy: this device's work is the one the
 * user can still see on screen.
 */
function newer(local: Show, remote: Show): Show {
  const a = time(local.updatedAt);
  const b = time(remote.updatedAt);
  if (b > a) return remote;
  return local;
}

function time(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
