/**
 * `runAutoStatusTask` (issue #329) — the Cloud Tasks handler. It must decide
 * from the booking and company as they are when the task RUNS, so the guards
 * (status, flag, since, stale) are each pinned by their own test.
 */
import { describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { FakeDb } from './fakeDb';
import { runAutoStatusTask } from '../../src/bookings/autoStatusTask';
import type { AutoStatusTask } from '../../src/bookings/autoStatusEnqueue';

const T = (iso: string) => Date.parse(iso);

const booking = {
  status: 'confirmed',
  startDate: '2026-06-15',
  startTime: '09:00',
  endDate: '2026-06-16',
  endTime: '17:00',
};
const DUE_OUT = T('2026-06-15T07:00:00Z');
const DUE_IN = T('2026-06-16T15:00:00Z');

const payload = (over: Record<string, unknown> = {}) => ({
  companyId: 'c1',
  bookingId: 'b1',
  transition: 'checkout',
  dueAt: DUE_OUT,
  ...over,
});

function setup(opts: { prefs?: Record<string, unknown>; booking?: Record<string, unknown> | null; now?: number } = {}) {
  const db = new FakeDb();
  db.set('companies/c1', {
    preferences: opts.prefs ?? { autoCheckout: true, autoCheckin: true, timezone: 'Europe/Stockholm' },
  });
  if (opts.booking !== null) db.set('companies/c1/bookings/b1', opts.booking ?? { ...booking });
  const tasks: AutoStatusTask[] = [];
  const enqueue = vi.fn(async (t: AutoStatusTask) => {
    tasks.push(t);
  });
  const now = opts.now ?? T('2026-06-15T07:00:30Z');
  return { db, tasks, enqueue, run: (p: unknown, id = 'parent-1') => runAutoStatusTask({ db: db.asFirestore(), enqueue, now: () => now }, p, id) };
}

describe('runAutoStatusTask apply', () => {
  it('checks out: status, checkedOutAt, checkOutSource auto, updatedAt — in one transaction', async () => {
    const s = setup();
    await s.run(payload());
    expect(s.db.transactionRuns).toBe(1);
    expect(s.db.updates).toHaveLength(1);
    const { path, data } = s.db.updates[0]!;
    expect(path).toBe('companies/c1/bookings/b1');
    expect(data.status).toBe('checked_out');
    expect(data.checkOutSource).toBe('auto');
    expect((data.checkedOutAt as FieldValue).isEqual(FieldValue.serverTimestamp())).toBe(true);
    expect((data.updatedAt as FieldValue).isEqual(FieldValue.serverTimestamp())).toBe(true);
    expect(Object.keys(data).sort()).toEqual(['checkOutSource', 'checkedOutAt', 'status', 'updatedAt']);
  });

  it('checks in: returned, returnedAt, returnSource auto', async () => {
    const s = setup({ booking: { ...booking, status: 'checked_out' }, now: DUE_IN + 1000 });
    await s.run(payload({ transition: 'checkin', dueAt: DUE_IN }));
    const { data } = s.db.updates[0]!;
    expect(data.status).toBe('returned');
    expect(data.returnSource).toBe('auto');
    expect((data.returnedAt as FieldValue).isEqual(FieldValue.serverTimestamp())).toBe(true);
    expect(Object.keys(data).sort()).toEqual(['returnSource', 'returnedAt', 'status', 'updatedAt']);
  });

  it('is idempotent: a duplicate delivery sees the new status and does nothing', async () => {
    const s = setup();
    await s.run(payload());
    await s.run(payload());
    expect(s.db.updates).toHaveLength(1);
  });
});

describe('runAutoStatusTask guards', () => {
  it('status guard: a cancelled / already checked-out booking is left alone', async () => {
    for (const status of ['cancelled', 'checked_out', 'returned', 'pending']) {
      const s = setup({ booking: { ...booking, status } });
      await s.run(payload());
      expect(s.db.updates).toEqual([]);
    }
  });

  it('status guard: a check-in task does not act on a confirmed booking', async () => {
    const s = setup({ now: DUE_IN + 1000 });
    await s.run(payload({ transition: 'checkin', dueAt: DUE_IN }));
    expect(s.db.updates).toEqual([]);
  });

  it('flag guard: does nothing when the flag was turned off after enqueueing', async () => {
    const s = setup({ prefs: { autoCheckout: false, autoCheckin: true, timezone: 'Europe/Stockholm' } });
    await s.run(payload());
    expect(s.db.updates).toEqual([]);
  });

  it('since guard: does nothing for a booking due before the flag since (forward-only)', async () => {
    const s = setup({
      prefs: {
        autoCheckout: true,
        timezone: 'Europe/Stockholm',
        autoCheckoutSince: { toMillis: () => DUE_OUT + 1 },
      },
    });
    await s.run(payload());
    expect(s.db.updates).toEqual([]);
  });

  it('missing booking is a no-op', async () => {
    const s = setup({ booking: null });
    await s.run(payload());
    expect(s.db.updates).toEqual([]);
  });

  it('stale: not yet due and the payload dueAt no longer matches — dropped, nothing enqueued', async () => {
    const s = setup({ now: T('2026-06-01T00:00:00Z') });
    await s.run(payload({ dueAt: T('2026-06-14T07:00:00Z') }));
    expect(s.db.updates).toEqual([]);
    expect(s.tasks).toEqual([]);
  });

  it('a rescheduled booking that is now overdue is applied even with an old payload dueAt', async () => {
    const s = setup();
    await s.run(payload({ dueAt: T('2026-06-30T07:00:00Z') }));
    expect(s.db.updates).toHaveLength(1);
  });
});

describe('runAutoStatusTask hop', () => {
  it('re-enqueues the next leg (capped at 29 days) with an id derived from the parent task id', async () => {
    const now = T('2026-06-01T00:00:00Z');
    const far = { ...booking, startDate: '2026-12-01' };
    const dueAt = T('2026-12-01T08:00:00Z');
    const s = setup({ booking: far, now });
    await s.run(payload({ dueAt }), 'parent-1');
    expect(s.db.updates).toEqual([]);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]!.payload).toEqual(payload({ dueAt }));
    expect(s.tasks[0]!.scheduleTime).toBe(now + 29 * 24 * 3600_000);
    expect(s.tasks[0]!.id).toMatch(/^checkout-[0-9a-f]{48}$/);

    const again = setup({ booking: far, now });
    await again.run(payload({ dueAt }), 'parent-1');
    expect(again.tasks[0]!.id).toBe(s.tasks[0]!.id);
    const other = setup({ booking: far, now });
    await other.run(payload({ dueAt }), 'parent-2');
    expect(other.tasks[0]!.id).not.toBe(s.tasks[0]!.id);
  });

  it('a duplicate-hop 409 is swallowed', async () => {
    const now = T('2026-06-01T00:00:00Z');
    const s = setup({ booking: { ...booking, startDate: '2026-12-01' }, now });
    s.enqueue.mockRejectedValueOnce({ code: 'functions/task-already-exists' });
    await expect(s.run(payload({ dueAt: T('2026-12-01T08:00:00Z') }))).resolves.toBeUndefined();
  });
});

describe('runAutoStatusTask payload validation', () => {
  it.each([
    ['null', null],
    ['not an object', 'x'],
    ['missing companyId', { bookingId: 'b1', transition: 'checkout', dueAt: 1 }],
    ['path-traversing id', payload({ bookingId: '../x' })],
    ['unknown transition', payload({ transition: 'delete' })],
    ['non-numeric dueAt', payload({ dueAt: '1' })],
    ['NaN dueAt', payload({ dueAt: NaN })],
  ])('drops an invalid payload (%s) without touching Firestore or retrying', async (_name, bad) => {
    const s = setup();
    await expect(s.run(bad)).resolves.toBeUndefined();
    expect(s.db.transactionRuns).toBe(0);
    expect(s.tasks).toEqual([]);
  });
});
