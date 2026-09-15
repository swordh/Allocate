/**
 * "Chunkningen" — issue #252 step 5, PR E. Seeds more documents than fit in
 * a single Firestore batch (500) into both a `recursiveDelete`-purged
 * subtree collection (bookings, >1000) and a chunked-`WriteBatch`
 * house-pattern orphan collection (companyEvents, >500), and proves zero
 * remain afterward. This is exactly where `purgeAuditLogs.ts`'s bug lives
 * (a single unchunked `batch.commit()` that throws past 500 writes) — see
 * that file's docblock in functions/src/admin/purgeAuditLogs.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { runCompanyPurge } from '../../functions/src/company/purge'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import { seedRequestedDeletion } from './companyDeletionFixtures'

async function seedMany(count: number, makeRef: (i: number) => FirebaseFirestore.DocumentReference, data: (i: number) => object) {
  // Firestore's own WriteBatch caps at 500 writes, same limit the
  // production code chunks under — mirrored here purely to seed the
  // fixture, nothing to do with the code under test.
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

describe('runCompanyPurge — chunking', () => {
  it('purges >1000 bookings (subtree/recursiveDelete) and >500 companyEvents (orphans/WriteBatch) to zero', async () => {
    const companyId = 'chunk-co'
    const requestId = 'chunk-req'
    const BOOKINGS = 1100
    const EVENTS = 620

    await seedRequestedDeletion(adminDb, { companyId, requestId })

    await seedMany(
      BOOKINGS,
      (i) => adminDb.doc(`companies/${companyId}/bookings/b${i}`),
      (i) => ({ title: `Booking ${i}` }),
    )
    await seedMany(
      EVENTS,
      (i) => adminDb.collection('companyEvents').doc(`e${i}`),
      (i) => ({ companyId, at: new Date().toISOString(), kind: `event-${i}` }),
    )

    const db = getTestFunctionsDb()
    // The emulator, unlike production Firestore, does not reject a
    // WriteBatch over the real 500-op limit — so "does chunking actually
    // fire" has to be asserted structurally (how many batches got created),
    // not by waiting for an over-limit commit to throw. 620 companyEvents
    // over BATCH_LIMIT (490) must take at least 2 batches if the orphans
    // phase's chunk-and-commit guard is doing anything at all.
    const batchSpy = vi.spyOn(db, 'batch')
    await runCompanyPurge(db, requestId)
    // Baseline `db.batch()` calls with no chunking needed at all: one each
    // for the (empty) invitations phase, the four orphan collections
    // (companyEvents, operatorNotes, operatorFeedback, stripeFailedPayments
    // — each opens a batch even when empty), and finalize's (empty, no
    // members seeded here) mail-queueing batch = 6. 620 companyEvents over
    // BATCH_LIMIT (490) must push that one leg through `commitAndReset` at
    // least once more — 7+ total — if the chunk-and-commit guard actually
    // fires. A mutation that disables that guard collapses this back to
    // exactly 6 (verified by hand against this exact test before writing
    // it this way — see the PR report's mutation-testing notes).
    expect(batchSpy.mock.calls.length).toBeGreaterThanOrEqual(7)
    batchSpy.mockRestore()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('completed')

    const bookingsSnap = await adminDb.collection(`companies/${companyId}/bookings`).get()
    expect(bookingsSnap.size).toBe(0)

    const eventsSnap = await adminDb.collection('companyEvents').where('companyId', '==', companyId).get()
    expect(eventsSnap.size).toBe(0)

    const companySnap = await adminDb.doc(`companies/${companyId}`).get()
    expect(companySnap.exists).toBe(false)
  }, 60_000)
})
