import { describe, it, expect } from 'vitest';
import { duplicateShow } from './duplicateShow';
import type { Show } from '../types';

const original = {
  id: 'show-1',
  name: 'Late Night Laughs',
  date: '2026-04-07',
  time: '20:00',
  location: 'Portland, OR',
  venueName: 'The Basement',
  status: 'completed',
  performers: [{ id: 'p1', name: 'Ada Cole' }],
  artists: [],
  schedule: [{ id: 's1', title: 'Doors' }],
  hosts: [],
  djSongs: [],
  staff: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  viewToken: 'live-token',
  viewNote: 'Doors at 7:30',
  recap: { attendance: 60 },
} as unknown as Show;

describe('duplicateShow', () => {
  it('carries the bill and the running order — that is the point of a copy', () => {
    const copy = duplicateShow(original);
    expect(copy.performers).toEqual(original.performers);
    expect(copy.schedule).toEqual(original.schedule);
    expect(copy.venueName).toBe('The Basement');
    expect(copy.time).toBe('20:00');
  });

  it('drops what belonged to that one night', () => {
    const copy = duplicateShow(original);
    // A copy carrying the viewer token would publish over the original's
    // live page.
    expect(copy.viewToken).toBeUndefined();
    expect(copy.viewNote).toBeUndefined();
    expect(copy.recap).toBeUndefined();
    expect(copy.status).toBe('upcoming');
    expect(copy.id).not.toBe(original.id);
  });

  it('clears the date when there is no new one, so the app asks for one', () => {
    expect(duplicateShow(original).date).toBe('');
    expect(duplicateShow(original).name).toBe('Late Night Laughs (copy)');
  });

  it('takes a date and keeps the name for a booked repeat', () => {
    const copy = duplicateShow(original, { name: original.name, date: '2026-04-14' });
    expect(copy.date).toBe('2026-04-14');
    expect(copy.name).toBe('Late Night Laughs');
  });

  it('is a deep copy — editing the copy cannot reach back into the original', () => {
    const copy = duplicateShow(original);
    copy.performers[0].name = 'Someone Else';
    expect(original.performers[0].name).toBe('Ada Cole');
  });

  it('gives every copy its own id', () => {
    const ids = new Set(Array.from({ length: 20 }, () => duplicateShow(original).id));
    expect(ids.size).toBe(20);
  });
});
