/**
 * `runBookingWritten` / `runCompanyUpdated` / `safeEnqueue` (issue #329) — the
 * enqueue side of automatic check-out / check-in. Plain functions of
 * `(deps, args)`, so these use a fake Firestore and a recording `enqueue`.
 */
import { describe, expect, it, vi } from 'vitest';
import { FakeDb } from './fakeDb';
import {
  runBookingWritten,
  runCompanyUpdated,
  safeEnqueue,
  type AutoStatusTask,
} from '../../src/bookings/autoStatusEnqueue';

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-06-01T00:00:00Z');

const booking = {
  status: 'confirmed',
  startDate: '2026-06-15',
  startTime: '09:00',
  endDate: '2026-06-16',
  endTime: '17:00',
};

function setup(prefs: Record<string, unknown> = { autoCheckout: true, autoCheckin: true, timezone: 'Europe/Stockholm' }) {
  const db = new FakeDb();
  db.set('companies/c1', { preferences: prefs });
  const tasks: AutoStatusTask[] = [];
  const enqueue = vi.fn(async (t: AutoStatusTask) => {
    tasks.push(t);
  });
  return { db, tasks, enqueue, deps: { db: db.asFirestore(), enqueue, now: () => NOW } };
}

describe('safeEnqueue', () => {
  const task: AutoStatusTask = {
    id: 't1',
    payload: { companyId: 'c1', bookingId: 'b1', transition: 'checkout', dueAt: 1 },
  };

  it('swallows a task-already-exists error', async () => {
    const enqueue = vi.fn().mockRejectedValue({ code: 'functions/task-already-exists' });
    await expect(safeEnqueue(enqueue, task)).resolves.toBeUndefined();
  });

  it('rethrows any other error', async () => {
    const enqueue = vi.fn().mockRejectedValue({ code: 'functions/permission-denied' });
    await expect(safeEnqueue(enqueue, task)).rejects.toMatchObject({ code: 'functions/permission-denied' });
    await expect(safeEnqueue(vi.fn().mockRejectedValue(new Error('boom')), task)).rejects.toThrow('boom');
  });
});

describe('runBookingWritten', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    eventId: 'evt-1',
    companyId: 'c1',
    bookingId: 'b1',
    after: booking,
    ...over,
  });

  it('enqueues a check-out at the company-local start time for a new confirmed booking', async () => {
    const { deps, tasks } = setup();
    await runBookingWritten(deps, args());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload).toEqual({
      companyId: 'c1',
      bookingId: 'b1',
      transition: 'checkout',
      dueAt: T('2026-06-15T07:00:00Z'),
    });
    expect(tasks[0]!.scheduleTime).toBe(T('2026-06-15T07:00:00Z'));
    expect(tasks[0]!.id).toMatch(/^checkout-[0-9a-f]{48}$/);
  });

  it('enqueues a check-in when the booking becomes checked_out (the loop stops at returned)', async () => {
    const { deps, tasks } = setup();
    await runBookingWritten(deps, args({ before: booking, after: { ...booking, status: 'checked_out' } }));
    expect(tasks.map((t) => t.payload.transition)).toEqual(['checkin']);
    expect(tasks[0]!.payload.dueAt).toBe(T('2026-06-16T15:00:00Z'));

    const second = setup();
    await runBookingWritten(second.deps, args({ before: { ...booking, status: 'checked_out' }, after: { ...booking, status: 'returned' } }));
    expect(second.tasks).toEqual([]);
  });

  it('the same event id gives the same task id; a different event gives a new one', async () => {
    const { deps, tasks } = setup();
    await runBookingWritten(deps, args());
    await runBookingWritten(deps, args());
    await runBookingWritten(deps, args({ eventId: 'evt-2' }));
    expect(tasks[0]!.id).toBe(tasks[1]!.id);
    expect(tasks[2]!.id).not.toBe(tasks[0]!.id);
  });

  it('reads nothing (not even the company) when only a field irrelevant to the transition changed', async () => {
    const { deps, tasks, db } = setup();
    const spy = vi.spyOn(db, 'collection');
    // confirmed booking: only the END time moved — check-out's due time is unaffected.
    await runBookingWritten(deps, args({ before: booking, after: { ...booking, endTime: '18:00' } }));
    // only updatedAt-style noise
    await runBookingWritten(deps, args({ before: booking, after: { ...booking, updatedAt: 1 } }));
    expect(spy).not.toHaveBeenCalled();
    expect(tasks).toEqual([]);
  });

  it('a late-created booking (after since) is enqueued even though its start has passed', async () => {
    const since = T('2026-05-20T00:00:00Z'); // after the 05-01 start, before NOW
    const { deps, tasks } = setup({
      autoCheckout: true,
      timezone: 'Europe/Stockholm',
      autoCheckoutSince: { toMillis: () => since },
    });
    await runBookingWritten(deps, args({ after: { ...booking, startDate: '2026-05-01', createdAt: { toMillis: () => since + 1 } } }));
    // The same booking created BEFORE since is ignored.
    await runBookingWritten(deps, args({ bookingId: 'b2', after: { ...booking, startDate: '2026-05-01', createdAt: { toMillis: () => since - 1 } } }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.scheduleTime).toBeUndefined();
  });

  it('treats a duplicate-delivery 409 as success', async () => {
    const { deps } = setup();
    const enqueue = vi.fn().mockRejectedValue({ code: 'functions/task-already-exists' });
    await expect(runBookingWritten({ ...deps, enqueue }, args())).resolves.toBeUndefined();
  });

  it('propagates other enqueue errors so the trigger retries', async () => {
    const { deps } = setup();
    const enqueue = vi.fn().mockRejectedValue(new Error('queue down'));
    await expect(runBookingWritten({ ...deps, enqueue }, args())).rejects.toThrow('queue down');
  });

  it('enqueues nothing when the flag is off, nothing relevant changed, or the booking is deleted/cancelled', async () => {
    const off = setup({ autoCheckout: false, autoCheckin: false });
    await runBookingWritten(off.deps, args());
    const same = setup();
    await runBookingWritten(same.deps, args({ before: booking }));
    const del = setup();
    await runBookingWritten(del.deps, args({ before: booking, after: undefined }));
    const cancelled = setup();
    await runBookingWritten(cancelled.deps, args({ before: booking, after: { ...booking, status: 'cancelled' } }));
    expect([off.tasks, same.tasks, del.tasks, cancelled.tasks]).toEqual([[], [], [], []]);
  });

  it('forward-only: a booking due before the flag since is not enqueued', async () => {
    const { deps, tasks } = setup({
      autoCheckout: true,
      timezone: 'Europe/Stockholm',
      autoCheckoutSince: { toMillis: () => T('2026-06-15T07:00:01Z') },
    });
    await runBookingWritten(deps, args());
    expect(tasks).toEqual([]);
  });

  it('caps scheduleTime at now + 29 days and leaves it undefined when already due', async () => {
    const { deps, tasks } = setup();
    await runBookingWritten(deps, args({ after: { ...booking, startDate: '2026-12-01' } }));
    expect(tasks[0]!.scheduleTime).toBe(NOW + 29 * 24 * 3600_000);
    expect(tasks[0]!.payload.dueAt).toBe(T('2026-12-01T08:00:00Z'));

    const past = setup();
    await runBookingWritten(past.deps, args({ after: { ...booking, startDate: '2026-05-01' } }));
    expect(past.tasks[0]!.scheduleTime).toBeUndefined();
  });
});

describe('runCompanyUpdated', () => {
  const on = { autoCheckout: true, autoCheckin: true, timezone: 'Europe/Stockholm' };
  const off = { autoCheckout: false, autoCheckin: false, timezone: 'Europe/Stockholm' };

  function seeded() {
    const s = setup();
    s.db.set('companies/c1/bookings/b-conf', { ...booking });
    s.db.set('companies/c1/bookings/b-out', { ...booking, status: 'checked_out' });
    s.db.set('companies/c1/bookings/b-pend', { ...booking, status: 'pending' });
    s.db.set('companies/c1/bookings/b-old', { ...booking, startDate: '2026-04-01' });
    s.db.set('companies/c2/bookings/other', { ...booking });
    return s;
  }

  it('flag false → true enqueues that company\'s matching bookings only', async () => {
    const { deps, tasks } = seeded();
    await runCompanyUpdated(deps, {
      eventId: 'e1',
      companyId: 'c1',
      before: { preferences: off },
      after: { preferences: { ...off, autoCheckout: true, autoCheckoutSince: { toMillis: () => T('2026-05-01T00:00:00Z') } } },
    });
    // b-conf (due June 15) yes; b-old (due April 1) is before since — forward-only; no other company, no checkin.
    expect(tasks.map((t) => `${t.payload.transition}:${t.payload.bookingId}`)).toEqual(['checkout:b-conf']);
  });

  it('both flags on at once enqueue both transitions', async () => {
    const { deps, tasks } = seeded();
    await runCompanyUpdated(deps, { eventId: 'e1', companyId: 'c1', before: { preferences: off }, after: { preferences: on } });
    expect(tasks.map((t) => `${t.payload.transition}:${t.payload.bookingId}`).sort()).toEqual([
      'checkin:b-out',
      'checkout:b-conf',
      'checkout:b-old',
    ]);
  });

  it('a time zone change re-enqueues with the new due time', async () => {
    const { deps, tasks } = seeded();
    await runCompanyUpdated(deps, {
      eventId: 'e1',
      companyId: 'c1',
      before: { preferences: on },
      after: { preferences: { ...on, timezone: 'UTC' } },
    });
    const conf = tasks.find((t) => t.payload.bookingId === 'b-conf')!;
    expect(conf.payload.dueAt).toBe(T('2026-06-15T09:00:00Z'));
  });

  it('returns early without querying bookings when preferences are unchanged (stats mirror writes)', async () => {
    const { deps, tasks, db } = seeded();
    const spy = vi.spyOn(db, 'collection');
    await runCompanyUpdated(deps, {
      eventId: 'e1',
      companyId: 'c1',
      before: { preferences: on, stats: { a: 1 } },
      after: { preferences: on, stats: { a: 2 } },
    });
    expect(tasks).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when a flag is turned off', async () => {
    const { deps, tasks } = seeded();
    await runCompanyUpdated(deps, { eventId: 'e1', companyId: 'c1', before: { preferences: on }, after: { preferences: off } });
    expect(tasks).toEqual([]);
  });
});
