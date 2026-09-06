import { describe, it, expect } from 'vitest';
import { mergePendingShows } from './mergePending';
import type { DeletedItem, Show } from '../types';

const show = (id: string, over: Partial<Show> = {}): Show =>
  ({
    id,
    name: id,
    date: '2026-04-01',
    time: '20:00',
    location: '',
    venueName: '',
    status: 'upcoming',
    performers: [],
    artists: [],
    schedule: [],
    hosts: [],
    djSongs: [],
    staff: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...over,
  }) as Show;

const trashed = (s: Show): DeletedItem => ({
  id: `t-${s.id}`,
  type: 'show',
  data: s,
  deletedAt: '2026-03-02T00:00:00.000Z',
});

describe('mergePendingShows', () => {
  it('keeps a show added elsewhere while this device could not save', () => {
    // The reported failure: the phone held an older list, and restoring it
    // wholesale deleted the show made on the laptop in the meantime.
    const merged = mergePendingShows([show('a')], [show('a'), show('b')]);
    expect(merged.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps unsaved work the server has never seen', () => {
    const merged = mergePendingShows([show('a'), show('new')], [show('a')]);
    expect(merged.map((s) => s.id).sort()).toEqual(['a', 'new']);
  });

  it('lets the newer edit win, whichever device made it', () => {
    const local = show('a', { name: 'from the phone', updatedAt: '2026-03-05T00:00:00.000Z' });
    const remote = show('a', { name: 'from the laptop', updatedAt: '2026-03-06T00:00:00.000Z' });
    expect(mergePendingShows([local], [remote])[0].name).toBe('from the laptop');
    expect(mergePendingShows([remote], [local])[0].name).toBe('from the laptop');
  });

  it('keeps this device’s copy when neither side carries a usable stamp', () => {
    const local = show('a', { name: 'held here', updatedAt: '' });
    const remote = show('a', { name: 'on the server', updatedAt: 'not a date' });
    expect(mergePendingShows([local], [remote])[0].name).toBe('held here');
  });

  it('does not resurrect a show the user deleted — the trash is the record', () => {
    const gone = show('gone');
    const merged = mergePendingShows([show('a')], [show('a'), gone], [trashed(gone)]);
    expect(merged.map((s) => s.id)).toEqual(['a']);
  });

  it('returns the server’s list untouched when the held copy is empty', () => {
    expect(mergePendingShows([], [show('a'), show('b')]).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('survives junk on either side rather than dropping the rest', () => {
    const merged = mergePendingShows(
      [show('a'), undefined as unknown as Show],
      [show('b'), null as unknown as Show],
    );
    expect(merged.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});
