/**
 * `functions/src/admin/purgeOldFeedback.ts` — issue #338 PR 2. Proves the
 * three cases the docblock's GDPR Art. 5(1)(e) rationale depends on:
 * a ticket closed long ago (with a `notes` subcollection) is deleted in
 * full, a ticket closed recently is left alone, and an OPEN ticket — no
 * `closedAt` at all, however old its `submittedAt` — is never purged,
 * because it has nothing for the `<` range filter to match. Also proves
 * the sweep doesn't fall over past Firestore's 500-write batch limit, the
 * same class of bug `purgeAuditLogs.ts`'s original unchunked version had
 * (see that file's docblock) — this function sidesteps it entirely by
 * using `recursiveDelete`/BulkWriter rather than a manual `WriteBatch`, so
 * this test is really proving that choice holds at scale, not exercising a
 * chunk-and-commit loop of its own.
 *
 * Every test below also asserts `result.failed === 0` — the sweep's return
 * shape changed from `{ purged }` to `{ purged, failed }` in code review
 * (the first version reported `snap.size` as "purged" regardless of
 * whether the deletes actually succeeded).
 *
 * NOT covered here: the reopen-race guard (`isStillEligibleForPurge`,
 * re-reading a ticket immediately before its delete to skip one reopened
 * or reclassified since the sweep's initial query ran). That guard's pure
 * logic is unit-tested directly in
 * `__tests__/functions/purgeOldFeedbackReopenGuard.test.ts` — genuinely
 * forcing the race itself (a write landing in the exact window between
 * this function's query and a specific ticket's delete) isn't practically
 * simulable against a real emulator without adding a test-only seam to the
 * production function, which wasn't judged worth it for a millisecond-wide
 * window. See that function's own docblock for the accepted residual risk.
 */
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { purgeOldFeedbackSweep } from '../../functions/src/admin/purgeOldFeedback'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'

const TWENTY_FIVE_MONTHS_AGO = Timestamp.fromMillis(Date.now() - 25 * 30 * 24 * 60 * 60 * 1000)
// Deliberately NOT "recent" in the everyday sense — 20 months is well past
// a 1-month or even 12-month cutoff, but still inside the real 24-month
// one. A test suite that only ever tries a 1-day-old fixture next to a
// 25-month-old one can't tell a correct 24-month cutoff apart from a wrong
// 1-month one (both give the same purged/kept answer for those two points);
// this fixture is what actually pins the boundary at 24 months instead of
// merely "somewhere more than a day and less than 25 months".
const TWENTY_MONTHS_AGO = Timestamp.fromMillis(Date.now() - 20 * 30 * 24 * 60 * 60 * 1000)
const RECENT = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000)
const VERY_OLD_SUBMITTED = Timestamp.fromMillis(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000)

async function seedMany(count: number, makeRef: (i: number) => FirebaseFirestore.DocumentReference, data: (i: number) => object) {
  const CHUNK = 450
  for (let start = 0; start < count; start += CHUNK) {
    const batch = adminDb.batch()
    const end = Math.min(start + CHUNK, count)
    for (let i = start; i < end; i++) {
      batch.set(makeRef(i), data(i))
    }
    await batch.commit()
  }
}

describe('purgeOldFeedbackSweep', () => {
  it('deletes a ticket closed >24 months ago, including its notes subcollection', async () => {
    const ticketRef = adminDb.collection('operatorFeedback').doc('old-closed')
    await ticketRef.set({
      status: 'done',
      closedAt: TWENTY_FIVE_MONTHS_AGO,
      submittedAt: TWENTY_FIVE_MONTHS_AGO,
      title: 'Old ticket',
      description: 'Fixed a while ago',
      companyId: 'company-A',
    })
    await ticketRef.collection('notes').doc('note-1').set({
      kind: 'note',
      text: 'Looked into it',
      createdAt: TWENTY_FIVE_MONTHS_AGO,
      createdBy: 'operator@allocate.at',
    })
    await ticketRef.collection('notes').doc('event-1').set({
      kind: 'event',
      text: 'Status changed OPEN → DONE',
      createdAt: TWENTY_FIVE_MONTHS_AGO,
      createdBy: 'operator@allocate.at',
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldFeedbackSweep(db)
    expect(result.purged).toBe(1)
    expect(result.failed).toBe(0)

    expect((await ticketRef.get()).exists).toBe(false)
    const notesSnap = await ticketRef.collection('notes').get()
    expect(notesSnap.empty).toBe(true)
  })

  it('leaves a recently closed ticket alone', async () => {
    const ticketRef = adminDb.collection('operatorFeedback').doc('recent-closed')
    await ticketRef.set({
      status: 'wont_fix',
      closedAt: RECENT,
      submittedAt: RECENT,
      title: 'Recent ticket',
      companyId: 'company-A',
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldFeedbackSweep(db)
    expect(result.purged).toBe(0)
    expect(result.failed).toBe(0)
    expect((await ticketRef.get()).exists).toBe(true)
  })

  it('keeps a ticket closed 20 months ago — inside the 24-month cutoff, not merely "not recent"', async () => {
    const ticketRef = adminDb.collection('operatorFeedback').doc('twenty-months-closed')
    await ticketRef.set({
      status: 'done',
      closedAt: TWENTY_MONTHS_AGO,
      submittedAt: TWENTY_MONTHS_AGO,
      title: 'Closed 20 months ago',
      companyId: 'company-A',
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldFeedbackSweep(db)
    expect(result.purged).toBe(0)
    expect(result.failed).toBe(0)
    expect((await ticketRef.get()).exists).toBe(true)
  })

  it('never purges an open ticket, however old its submittedAt is — it has no closedAt to match', async () => {
    const ticketRef = adminDb.collection('operatorFeedback').doc('old-but-open')
    await ticketRef.set({
      status: 'open',
      submittedAt: VERY_OLD_SUBMITTED,
      title: 'Still open',
      companyId: 'company-A',
      // deliberately no closedAt field at all
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldFeedbackSweep(db)
    expect(result.purged).toBe(0)
    expect(result.failed).toBe(0)
    expect((await ticketRef.get()).exists).toBe(true)
  })

  it('purges >500 old closed tickets without falling over the batch limit', async () => {
    const COUNT = 620
    await seedMany(
      COUNT,
      (i) => adminDb.collection('operatorFeedback').doc(`bulk-${i}`),
      (i) => ({
        status: 'done',
        closedAt: TWENTY_FIVE_MONTHS_AGO,
        submittedAt: TWENTY_FIVE_MONTHS_AGO,
        title: `Bulk ticket ${i}`,
        companyId: 'company-A',
      }),
    )
    // A recent one thrown into the same sweep, to prove it survives
    // alongside the bulk purge rather than the whole collection being wiped.
    await adminDb.collection('operatorFeedback').doc('bulk-survivor').set({
      status: 'done',
      closedAt: RECENT,
      submittedAt: RECENT,
      title: 'Survivor',
      companyId: 'company-A',
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldFeedbackSweep(db)
    expect(result.purged).toBe(COUNT)
    expect(result.failed).toBe(0)

    const remaining = await adminDb.collection('operatorFeedback').get()
    expect(remaining.size).toBe(1)
    expect(remaining.docs[0].id).toBe('bulk-survivor')
  }, 30_000)

  it('does nothing when nothing is old enough', async () => {
    const db = getTestFunctionsDb()
    const result = await purgeOldFeedbackSweep(db)
    expect(result.purged).toBe(0)
    expect(result.failed).toBe(0)
  })
})
