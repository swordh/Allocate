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
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { purgeCompanyDeletionLogsSweep, BATCH_LIMIT } from '../../functions/src/company/purgeLogs'
import { expectOnlyTheseFieldsChanged, spyOnBatchWrites } from './redactionAssertions'
import { getTestFunctionsDb, FunctionsTimestamp } from '../../functions/src/testSupport/emulatorInit'

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
    const before = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.eligible).toBe(1)
    expect(result.redacted).toBe(1)
    expect(result.failedBatches).toBe(0)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    // The whole claim, as a key-set diff rather than a list of fields anyone
    // can forget to extend: exactly these keys may differ, exactly this one
    // may appear, and NOTHING may disappear. An enumeration cannot catch a
    // field that vanishes or one that is quietly added — and a vanished
    // `purgeAfter` in particular would drop the row out of this rule's own
    // range query forever, since Firestore does not return documents missing
    // the field being compared.
    expectOnlyTheseFieldsChanged(before, after, {
      mayChange: [
        'requestedByUid',
        'requestedByName',
        'requestedByEmail',
        'canceledByUid',
        'canceledByName',
        'canceledByEmail',
        'lastError',
        'operatorActions',
      ],
      mayAppear: ['identityRedactedAt'],
    })

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

  it('redacts a row exactly AT its deadline, and not one millisecond before', async () => {
    // The `<=` in the query cannot be pinned without controlling the clock:
    // `Timestamp.now()` taken inside the sweep can never equal a seeded
    // `purgeAfter`. With `now` injected it can, which is the only way to tell
    // `<=` from `<` — a mutation that silently postpones every deadline by one
    // sweep interval, forever, on rows nobody is watching.
    const atMs = Date.now() - 60_000
    await adminDb.doc('companyDeletions/exactly-due').set(
      fullLedgerRow('exactly-due', Timestamp.fromMillis(atMs)),
    )
    await adminDb.doc('companyDeletions/one-ms-early').set(
      fullLedgerRow('one-ms-early', Timestamp.fromMillis(atMs + 1)),
    )

    // Built with functions/'s own Timestamp class: this value is passed INTO
    // functions/src code and written from there, and the Admin SDK refuses a
    // Timestamp instance from a different copy of firebase-admin. Values read
    // back below come through the root package and are compared by millis.
    const result = await purgeCompanyDeletionLogsSweep(
      getTestFunctionsDb(),
      FunctionsTimestamp.fromMillis(atMs),
    )
    expect(result.redacted).toBe(1)

    const due = (await adminDb.doc('companyDeletions/exactly-due').get()).data()!
    const early = (await adminDb.doc('companyDeletions/one-ms-early').get()).data()!
    expect(due.requestedByUid).toBeNull()
    // The marker is the injected instant, exactly — no wall-clock slop.
    expect(due.identityRedactedAt.toMillis()).toBe(atMs)
    expect(early.requestedByUid).toBe('requester-uid')
    expect('identityRedactedAt' in early).toBe(false)
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
    // Counts EVERY write operation, not just `update`: a future version that
    // adds a `set` or a `delete` per row is exactly the divergence this guard
    // exists for, and a spy watching `update` alone would report 490 while the
    // real batch carried 980. Restored in a `finally` — `getTestFunctionsDb()`
    // is a singleton for the whole file, so a throw here would otherwise leak
    // the patched `batch` into every test that runs after this one.
    const { writesPerBatch, restore } = spyOnBatchWrites(db)
    let result
    try {
      result = await purgeCompanyDeletionLogsSweep(db)
    } finally {
      restore()
    }

    expect(result.eligible).toBe(COUNT)
    expect(result.redacted).toBe(COUNT)
    expect(result.failedBatches).toBe(0)
    expect(result.failedRows).toBe(0)

    // Pins the constant, with LITERALS on purpose.
    //
    // Writing this as `[BATCH_LIMIT, COUNT - BATCH_LIMIT]` reads better and is
    // worthless: the expectation then moves with the constant, so raising
    // BATCH_LIMIT from 490 to 500 — production behaviour changed, headroom
    // under Firestore's cap gone — keeps the test green. Measured, not
    // assumed: that mutation survived the constant-relative form and is felled
    // by this one. 600 rows at 490 per chunk is 490 + 110, and nothing else.
    expect(BATCH_LIMIT).toBe(490)
    expect(writesPerBatch).toEqual([490, 110])

    // And the data itself: zero rows left unredacted.
    const all = await adminDb.collection('companyDeletions').get()
    expect(all.size).toBe(COUNT)
    const unredacted = all.docs.filter((d) => d.data().requestedByUid !== null || !d.data().identityRedactedAt)
    expect(unredacted.length).toBe(0)
  })
})
