/**
 * "Revisionsloggen" — issue #252 step 5, PR G. The 24-month retention job
 * over `companyDeletions` REDACTS the identity behind a deletion and leaves
 * the event itself standing, because step 6's operator view has to be able to
 * show an old deletion's history without being able to point out who was
 * behind it. See the GDPR/Art. 17(3)(e) docblock on `CompanyDeletionRecord`
 * in types/company.ts.
 *
 * The four things that can go wrong, each covered below:
 *   1. redacting too much — the row must survive field for field.
 *   2. redacting too early — a row inside its 24 months is untouchable.
 *   3. redacting twice — the marker must make a second run a no-op, including
 *      leaving the ORIGINAL `identityRedactedAt` value alone.
 *   4. redacting only the first 500 — the `purgeAuditLogs.ts` bug. Seeded
 *      with 600 rows here; a three-row test proves nothing about it.
 * Plus: a row that was never cancelled must not come out of this carrying a
 * fabricated "someone cancelled this, and we scrubbed them" marker.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it, vi } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { purgeCompanyDeletionLogsSweep, BATCH_LIMIT } from '../../functions/src/company/purgeLogs'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'

const DAY = 24 * 60 * 60 * 1000
const past = (ms: number) => Timestamp.fromMillis(Date.now() - ms)
const future = (ms: number) => Timestamp.fromMillis(Date.now() + ms)
const OPERATOR_ACTION_AT = new Date(Date.now() - 794 * DAY).toISOString()

/**
 * A ledger row as a COMPLETED deletion leaves it — deliberately rich, since
 * the central claim of this whole feature is that everything except the six
 * identity fields survives redaction untouched.
 */
function fullLedgerRow(requestId: string, purgeAfter: Timestamp, opts: { canceled?: boolean } = {}) {
  const requestedAt = past(800 * DAY)
  return {
    requestId,
    companyId: `co-${requestId}`,
    companyName: 'Acme Film AB',
    mode: 'window',
    state: opts.canceled ? 'canceled' : 'completed',
    requestedAt,
    requestedByUid: 'requester-uid',
    requestedByName: 'Requester Name',
    requestedByEmail: 'requester@example.com',
    scheduledFor: past(793 * DAY),
    completedAt: past(793 * DAY),
    ...(opts.canceled
      ? {
          canceledAt: past(795 * DAY),
          canceledByUid: 'canceller-uid',
          canceledByName: 'Canceller Name',
          canceledByEmail: 'canceller@example.com',
          cancelSource: 'email_link',
        }
      : {}),
    phase: 'finalize',
    completedPhases: ['stripe', 'invitations', 'members', 'subtree', 'orphans', 'finalize'],
    phaseCounts: { bookings: 42, companyEvents: 7 },
    operatorActions: [
      {
        action: 'note_added',
        byUid: 'op-uid',
        byName: 'Olga Operator',
        at: OPERATOR_ACTION_AT,
        note: 'Rang kunden, de ville inte ha kvar kontot. Ring inte igen.',
      },
    ],
    attempts: 1,
    lastError: 'FirebaseAuthError: no user record for uid mR8xQ (tobias@example.com), stripe cus_TESTCUSTOMER',
    purgeAfter,
  }
}

describe('purgeCompanyDeletionLogsSweep — 24-month identity redaction', () => {
  it('redacts the identity of an overdue row and leaves every other field byte-identical', async () => {
    const requestId = 'overdue-canceled'
    const row = fullLedgerRow(requestId, past(1 * DAY), { canceled: true })
    await adminDb.doc(`companyDeletions/${requestId}`).set(row)

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.eligible).toBe(1)
    expect(result.redacted).toBe(1)
    expect(result.failedBatches).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    // The row is still there. Never deleted, that is the entire point.
    expect(after).toBeTruthy()

    // Identity: present, and null. Not absent — see the `null` vs
    // FieldValue.delete() rationale in purgeLogs.ts. "Present and null" is
    // what lets the operator view say "redacted" rather than "never existed".
    for (const field of [
      'requestedByUid',
      'requestedByName',
      'requestedByEmail',
      'canceledByUid',
      'canceledByName',
      'canceledByEmail',
    ]) {
      expect(field in after).toBe(true)
      expect(after[field]).toBeNull()
    }
    expect(after.identityRedactedAt).toBeInstanceOf(Timestamp)

    // Everything else, field for field.
    expect(after.requestId).toBe(row.requestId)
    expect(after.companyId).toBe(row.companyId)
    expect(after.companyName).toBe('Acme Film AB')
    expect(after.mode).toBe('window')
    expect(after.state).toBe('canceled')
    expect(after.requestedAt).toEqual(row.requestedAt)
    expect(after.scheduledFor).toEqual(row.scheduledFor)
    expect(after.completedAt).toEqual(row.completedAt)
    expect(after.canceledAt).toEqual(row.canceledAt)
    expect(after.cancelSource).toBe('email_link')
    expect(after.phase).toBe('finalize')
    expect(after.completedPhases).toEqual(row.completedPhases)
    expect(after.phaseCounts).toEqual(row.phaseCounts)
    expect(after.attempts).toBe(1)

    // `lastError` is raw exception text and quotes a uid, an email address and
    // a Stripe customer id — nulled, and provably gone from the row.
    expect(after.lastError).toBeNull()

    // Operator notes: the intervention stays, the intervening person and what
    // they wrote about the customer do not.
    expect(after.operatorActions).toEqual([
      { action: 'note_added', at: OPERATOR_ACTION_AT, byUid: null, byName: null },
    ])

    const serialized = JSON.stringify(after)
    for (const needle of ['Olga Operator', 'Ring inte igen', 'tobias@example.com', 'cus_TESTCUSTOMER', 'mR8xQ', 'op-uid']) {
      expect(serialized).not.toContain(needle)
    }
    expect(after.purgeAfter).toEqual(row.purgeAfter)
  })

  it('leaves a row whose purgeAfter has not passed completely untouched', async () => {
    const requestId = 'not-yet-due'
    const row = fullLedgerRow(requestId, future(30 * DAY), { canceled: true })
    await adminDb.doc(`companyDeletions/${requestId}`).set(row)

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.eligible).toBe(0)
    expect(result.redacted).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.requestedByUid).toBe('requester-uid')
    expect(after.requestedByName).toBe('Requester Name')
    expect(after.requestedByEmail).toBe('requester@example.com')
    expect(after.canceledByUid).toBe('canceller-uid')
    expect(after.canceledByName).toBe('Canceller Name')
    expect(after.canceledByEmail).toBe('canceller@example.com')
    expect('identityRedactedAt' in after).toBe(false)
  })

  it('never picks up an already-redacted row, and a second sweep changes nothing', async () => {
    const requestId = 'already-redacted'
    const originalMarker = past(100 * DAY)
    await adminDb.doc(`companyDeletions/${requestId}`).set({
      ...fullLedgerRow(requestId, past(101 * DAY)),
      requestedByUid: null,
      requestedByName: null,
      requestedByEmail: null,
      identityRedactedAt: originalMarker,
    })

    const first = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(first.eligible).toBe(0)
    expect(first.redacted).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    // The marker keeps its ORIGINAL value. A re-redaction would overwrite it
    // with "now" and quietly lie about when the identity actually went away.
    expect(after.identityRedactedAt).toEqual(originalMarker)
  })

  it('is idempotent: running the sweep twice redacts on the first run only', async () => {
    const requestId = 'run-twice'
    await adminDb.doc(`companyDeletions/${requestId}`).set(fullLedgerRow(requestId, past(1 * DAY)))

    const db = getTestFunctionsDb()
    const first = await purgeCompanyDeletionLogsSweep(db)
    expect(first.redacted).toBe(1)
    const afterFirst = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    const second = await purgeCompanyDeletionLogsSweep(db)
    expect(second.eligible).toBe(0)
    expect(second.redacted).toBe(0)

    const afterSecond = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(afterSecond).toEqual(afterFirst)
  })

  it('does not fabricate cancel-identity fields on a deletion that was never cancelled', async () => {
    const requestId = 'never-canceled'
    await adminDb.doc(`companyDeletions/${requestId}`).set(fullLedgerRow(requestId, past(1 * DAY)))

    await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.requestedByUid).toBeNull()
    // Absent, NOT null. A null here would read as "someone cancelled this and
    // we scrubbed them" in the operator view — an event that never happened.
    for (const field of ['canceledByUid', 'canceledByName', 'canceledByEmail']) {
      expect(field in after).toBe(false)
    }
    expect(after.identityRedactedAt).toBeInstanceOf(Timestamp)
  })

  it('redacts every one of 600 overdue rows, in batches that stay under Firestore\'s 500-write cap', async () => {
    const COUNT = 600
    expect(COUNT).toBeGreaterThan(BATCH_LIMIT)

    // Seeded in sub-500 chunks purely to get the fixture in — nothing to do
    // with the code under test.
    const SEED_CHUNK = 450
    for (let start = 0; start < COUNT; start += SEED_CHUNK) {
      const batch = adminDb.batch()
      for (let i = start; i < Math.min(start + SEED_CHUNK, COUNT); i++) {
        batch.set(adminDb.doc(`companyDeletions/bulk-${i}`), fullLedgerRow(`bulk-${i}`, past(1 * DAY), { canceled: i % 2 === 0 }))
      }
      await batch.commit()
    }

    const db = getTestFunctionsDb()

    // The emulator, unlike production Firestore, does NOT reject a WriteBatch
    // over the real 500-op limit — so "does chunking actually fire" has to be
    // asserted structurally, by counting the writes that went into each batch,
    // rather than by waiting for an over-limit commit to throw. Same technique
    // and same reason as companyPurgeChunking.emulator.ts.
    const writesPerBatch: number[] = []
    const realBatch = db.batch.bind(db)
    const batchSpy = vi.spyOn(db, 'batch').mockImplementation(() => {
      const batch = realBatch()
      const slot = writesPerBatch.push(0) - 1
      const realUpdate = batch.update.bind(batch)
      const counting = (...args: unknown[]) => {
        writesPerBatch[slot] += 1
        return (realUpdate as (...a: unknown[]) => FirebaseFirestore.WriteBatch)(...args)
      }
      batch.update = counting as unknown as typeof batch.update
      return batch
    })

    const result = await purgeCompanyDeletionLogsSweep(db)
    batchSpy.mockRestore()

    expect(result.eligible).toBe(COUNT)
    expect(result.redacted).toBe(COUNT)
    expect(result.failedBatches).toBe(0)

    // More than one batch, and no batch anywhere near the real limit. An
    // unchunked implementation puts all 600 in one batch: the emulator would
    // happily accept it and every other assertion here would still pass,
    // which is exactly how the purgeAuditLogs.ts bug survived unnoticed.
    expect(writesPerBatch.length).toBeGreaterThan(1)
    expect(Math.max(...writesPerBatch)).toBeLessThanOrEqual(500)
    expect(writesPerBatch.reduce((a, b) => a + b, 0)).toBe(COUNT)

    // And the data itself: zero rows left unredacted.
    const all = await adminDb.collection('companyDeletions').get()
    expect(all.size).toBe(COUNT)
    const unredacted = all.docs.filter((d) => d.data().requestedByUid !== null || !d.data().identityRedactedAt)
    expect(unredacted.length).toBe(0)
  })
})
