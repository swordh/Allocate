/**
 * `deliverMail` (issue #325/#406, mail retention) — the `expireAt` field a
 * queued mail doc is stamped with by its writer (30 days out from queue
 * time, see `mailRetention.ts`) is re-anchored to `sentAt` via
 * `sentMailExpireAt` the moment delivery actually succeeds — both are 30
 * days since #406, so this no longer shortens the window, but `sentAt`
 * remains the correct anchor for a delivered mail. The retry/error branches
 * leave `expireAt` untouched, so an undelivered mail keeps its original
 * 30-day clock from when it was queued, giving time to investigate it.
 *
 * `sendEmail` (./send) is mocked so no real Resend call happens. Every mail
 * doc here is "raw" (no `template`, but `subject`/`html` set directly, see
 * `renderMail`'s `undefined`/`null`/`''` case) specifically to avoid pulling
 * in any of the real templates — this test is about the retention fields
 * `deliverMail` itself writes, not about rendering.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { ResendSendError } from '../../src/email/send';

const mockSendEmail = vi.fn();
vi.mock('../../src/email/send', async () => {
  const actual = await vi.importActual<typeof import('../../src/email/send')>('../../src/email/send');
  return { ...actual, sendEmail: (...args: unknown[]) => mockSendEmail(...args) };
});

import { deliverMail } from '../../src/email/mailDelivery';

const RAW_MAIL = { subject: 'Hej', html: '<p>Hej</p>', text: 'Hej' };

function fakeSnap(data: Record<string, unknown>): { snap: QueryDocumentSnapshot; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn().mockResolvedValue(undefined);
  const snap = {
    id: 'mail-1',
    data: () => data,
    ref: { update },
  } as unknown as QueryDocumentSnapshot;
  return { snap, update };
}

describe('deliverMail — expireAt handling', () => {
  beforeEach(() => {
    mockSendEmail.mockReset();
  });

  it('sent: rolls expireAt forward to ~now + 30 days', async () => {
    mockSendEmail.mockResolvedValue('resend-id-1');
    const before = Date.now();
    const { snap, update } = fakeSnap({ status: 'queued', to: 'a@example.com', ...RAW_MAIL });

    await deliverMail(snap, 'fake-api-key');
    const after = Date.now();

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0]![0] as { status: string; expireAt: { toMillis: () => number } };
    expect(call.status).toBe('sent');
    const expireMs = call.expireAt.toMillis();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    // Bounded window rather than an exact value — `before`/`after` bracket
    // whatever instant `Timestamp.now()` actually resolved to inside the call.
    expect(expireMs).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
    expect(expireMs).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
  });

  it('retry (transient failure, budget left): does not set expireAt at all', async () => {
    mockSendEmail.mockRejectedValue(new ResendSendError('rate_limit_exceeded', 'slow down'));
    const { snap, update } = fakeSnap({ status: 'queued', to: 'a@example.com', attempts: 0, ...RAW_MAIL });

    await deliverMail(snap, 'fake-api-key');

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.status).toBe('retry');
    expect(call).not.toHaveProperty('expireAt');
  });

  it('error (permanent failure): does not set expireAt at all — the doc keeps its original queue-time TTL', async () => {
    mockSendEmail.mockRejectedValue(new ResendSendError('invalid_from_address', 'bad from'));
    const { snap, update } = fakeSnap({ status: 'queued', to: 'a@example.com', ...RAW_MAIL });

    await deliverMail(snap, 'fake-api-key');

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.status).toBe('error');
    expect(call).not.toHaveProperty('expireAt');
  });

  it('error (transient failure, budget exhausted): still does not set expireAt', async () => {
    mockSendEmail.mockRejectedValue(new ResendSendError('rate_limit_exceeded', 'slow down'));
    const { snap, update } = fakeSnap({ status: 'retry', to: 'a@example.com', attempts: 4, ...RAW_MAIL });

    await deliverMail(snap, 'fake-api-key');

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.status).toBe('error');
    expect(call).not.toHaveProperty('expireAt');
  });
});
