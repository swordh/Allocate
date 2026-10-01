/**
 * "Failed blir synligt" — issue #331/#335. Two things used to never happen:
 * a purge that exhausts its retry budget never told the CUSTOMER (the
 * `companies/{cid}.deletion` mirror stayed `executing` forever — #331), and
 * a purge that times out on every single invocation never told ANYONE (a
 * 540s SIGKILL skips purge.ts's catch block, so `attempts` never grows and
 * the row just sits in `executing` — #335).
 *
 * This file exercises the fix for both: `applyFailedTransition`
 * (functions/src/company/failDeletion.ts), called from purge.ts's catch
 * block once `attempts` hits `MAX_ATTEMPTS`, and from `claimStaleLease`
 * (functions/src/company/lease.ts) once `NO_PROGRESS_LIMIT` consecutive
 * stale-lease resumes find no forward movement at all.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it, vi } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { runCompanyPurge } from '../../functions/src/company/purge'
import { claimStaleLease } from '../../functions/src/company/lease'
import { runCompanyDeletionSweep } from '../../functions/src/company/sweep'
import { getTestFunctionsDb, FunctionsTimestamp } from '../../functions/src/testSupport/emulatorInit'
import { seedRequestedDeletion, seedMember } from './companyDeletionFixtures'

/** Marks a seeded 'requested' ledger+mirror as already 'executing', the state every test here needs to start from. */
async function markExecuting(companyId: string, requestId: string, extra: Record<string, unknown> = {}) {
  await adminDb.doc(`companies/${companyId}`).update({ 'deletion.state': 'executing' })
  await adminDb.doc(`companyDeletions/${requestId}`).update({ state: 'executing', lastHeartbeatAt: Timestamp.now(), ...extra })
}

async function seedMany(count: number, makeRef: (i: number) => FirebaseFirestore.DocumentReference, data: (i: number) => object) {
  const CHUNK = 450
  for (let start = 0; start < count; start += CHUNK) {
    const batch = adminDb.batch()
    const end = Math.min(start + CHUNK, count)
    for (let i = start; i < end; i++) batch.set(makeRef(i), data(i))
    await batch.commit()
  }
}

describe('company deletion failure — attempts_exhausted (purge.ts catch block)', () => {
  it('marks the ledger AND the mirror failed, with a reason, a fresh heartbeat, and one mail per admin', async () => {
    const companyId = 'fail-exhaust-co'
    const requestId = 'fail-exhaust-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId, attempts: 4 })
    await markExecuting(companyId, requestId, { attempts: 4 })
    await seedMember(adminDb, companyId, 'fail-exhaust-admin-1', { role: 'admin', email: 'admin1@example.com' })
    await seedMember(adminDb, companyId, 'fail-exhaust-admin-2', { role: 'admin', email: 'admin2@example.com' })

    const db = getTestFunctionsDb()
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementation(() => {
      throw new Error('simulated permanent failure')
    })

    const before = Timestamp.now()
    await runCompanyPurge(db, requestId)
    spy.mockRestore()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.attempts).toBe(5)
    expect(ledger.state).toBe('failed')
    expect(ledger.failureReason).toBe('attempts_exhausted')
    expect(ledger.failedAt).toBeTruthy()
    expect((ledger.lastHeartbeatAt as FirebaseFirestore.Timestamp).toMillis()).toBeGreaterThanOrEqual(before.toMillis())
    expect(ledger.failedNotifiedAt).toBeTruthy()
    expect(ledger.failedNotifiedCount).toBe(2)

    const companySnap = (await adminDb.doc(`companies/${companyId}`).get()).data()!
    expect(companySnap.deletion.state).toBe('failed')

    const mailSnap = await adminDb.collection('mail').where('template', '==', 'companyDeletionFailed').where('companyId', '==', companyId).get()
    expect(mailSnap.size).toBe(2)
    const recipients = mailSnap.docs.map((d) => d.data()['to']).sort()
    expect(recipients).toEqual(['admin1@example.com', 'admin2@example.com'])
  })

  it('tolerates the company document already being gone (a finalize-phase crash on an earlier attempt)', async () => {
    const companyId = 'fail-nocompany-co'
    const requestId = 'fail-nocompany-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId, attempts: 4, completedPhases: ['stripe', 'invitations', 'members'] })
    await markExecuting(companyId, requestId, { attempts: 4 })
    await adminDb.doc(`companies/${companyId}`).delete()

    const db = getTestFunctionsDb()
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementation(() => {
      throw new Error('simulated permanent failure')
    })

    await expect(runCompanyPurge(db, requestId)).resolves.not.toThrow()
    spy.mockRestore()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')
    expect(ledger.failureReason).toBe('attempts_exhausted')
    // No admins to read (the company — and its members subcollection — are
    // gone), 'window' mode, requestedByEmail present on the fixture: falls
    // back to the requester's own address.
    const mailSnap = await adminDb.collection('mail').where('template', '==', 'companyDeletionFailed').where('companyId', '==', companyId).get()
    expect(mailSnap.size).toBe(1)
    expect(mailSnap.docs[0]!.data()['to']).toBe('requester@example.com')
  })

  it('does NOT overwrite the mirror when a newer deletion request has since replaced it (requestId mismatch)', async () => {
    const companyId = 'fail-mismatch-co'
    const requestId = 'fail-mismatch-req'
    const newerRequestId = 'fail-mismatch-req-2'

    await seedRequestedDeletion(adminDb, { companyId, requestId, attempts: 4 })
    await markExecuting(companyId, requestId, { attempts: 4 })
    // Simulate a second, newer request overwriting the mirror — the OLD
    // ledger (requestId) is what's about to fail, but the mirror now points
    // at a different, currently-live request.
    await adminDb.doc(`companies/${companyId}`).update({
      'deletion.requestId': newerRequestId,
      'deletion.state': 'requested',
    })

    const db = getTestFunctionsDb()
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementation(() => {
      throw new Error('simulated permanent failure')
    })
    await runCompanyPurge(db, requestId)
    spy.mockRestore()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')

    const companySnap = (await adminDb.doc(`companies/${companyId}`).get()).data()!
    // Untouched — still the NEWER request, still 'requested', not clobbered
    // by the older request's failure.
    expect(companySnap.deletion.requestId).toBe(newerRequestId)
    expect(companySnap.deletion.state).toBe('requested')
  })

  it('does not send mail a second time when failedNotifiedAt is already set', async () => {
    const companyId = 'fail-alreadynotified-co'
    const requestId = 'fail-alreadynotified-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId, attempts: 4 })
    await markExecuting(companyId, requestId, {
      attempts: 4,
      failedNotifiedAt: Timestamp.fromMillis(Date.now() - 60_000),
      failedNotifiedCount: 1,
    })
    await seedMember(adminDb, companyId, 'fail-alreadynotified-admin-1', { role: 'admin', email: 'admin@example.com' })

    const db = getTestFunctionsDb()
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementation(() => {
      throw new Error('simulated permanent failure')
    })
    await runCompanyPurge(db, requestId)
    spy.mockRestore()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')
    expect(ledger.failedNotifiedCount).toBe(1) // untouched, not re-sent/re-counted

    const mailSnap = await adminDb.collection('mail').where('template', '==', 'companyDeletionFailed').where('companyId', '==', companyId).get()
    expect(mailSnap.size).toBe(0)
  })

  it('runCompanyPurge on an already-failed row is a no-op — including one whose next unrun phase is finalize', async () => {
    // Deliberately seeded with every phase EXCEPT finalize already complete.
    // finalize is the one phase `markPhaseComplete`'s transactional liveness
    // guard never covers (it sets 'completed' directly — see its own
    // docblock), so THIS is the case that actually depends on
    // runCompanyPurge's own top-level early return: a failed row whose next
    // phase happens to be finalize would otherwise run finalize unguarded,
    // delete the company, and stamp 'completed' straight over 'failed'.
    const companyId = 'fail-noop-co'
    const requestId = 'fail-noop-req'

    await seedRequestedDeletion(adminDb, {
      companyId,
      requestId,
      completedPhases: ['stripe', 'invitations', 'members', 'subtree', 'orphans'],
    })
    await adminDb.doc(`companyDeletions/${requestId}`).update({ state: 'failed', failureReason: 'attempts_exhausted', attempts: 5 })

    const db = getTestFunctionsDb()

    await runCompanyPurge(db, requestId)

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.attempts).toBe(5) // untouched
    expect(ledger.state).toBe('failed') // NOT overwritten to 'completed' by an unguarded finalize
    expect((await adminDb.doc(`companies/${companyId}`).get()).exists).toBe(true) // never purged/deleted
  })

  it('a state change mid-run (PurgeAbortedError) leaves attempts untouched and does not overwrite the concurrent write', async () => {
    const companyId = 'fail-aborted-co'
    const requestId = 'fail-aborted-req'

    await seedRequestedDeletion(adminDb, {
      companyId,
      requestId,
      completedPhases: ['stripe', 'invitations', 'members'], // about to run subtree
    })
    await markExecuting(companyId, requestId)

    const db = getTestFunctionsDb()
    // Simulate an operator's "mark as failed" action landing WHILE the
    // subtree phase is running: recursiveDelete "succeeds" (from purge's
    // point of view) but, as a side effect, the ledger's state has already
    // moved to 'failed' with a DIFFERENT reason by the time
    // markPhaseComplete re-reads it.
    const spy = vi.spyOn(db, 'recursiveDelete').mockImplementation(async () => {
      await adminDb.doc(`companyDeletions/${requestId}`).update({ state: 'failed', failureReason: 'operator' })
    })

    await expect(runCompanyPurge(db, requestId)).resolves.not.toThrow()
    spy.mockRestore()

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')
    expect(ledger.failureReason).toBe('operator') // NOT overwritten to attempts_exhausted
    expect(ledger.attempts).toBe(0) // never burned — this was not this run's failure to record
    expect('lastError' in ledger).toBe(false)
  })
})

describe('company deletion failure — no_progress (lease.ts claimStaleLease)', () => {
  it('three consecutive no-progress stale-lease claims transition the row to failed', async () => {
    const companyId = 'fail-noprogress-co'
    const requestId = 'fail-noprogress-req'

    const staleHeartbeat = Timestamp.fromMillis(Date.now() - 62 * 60 * 1000)
    await seedRequestedDeletion(adminDb, { companyId, requestId, completedPhases: ['stripe'] })
    await markExecuting(companyId, requestId, { progressUnits: 3, attempts: 0, lastHeartbeatAt: staleHeartbeat })
    await seedMember(adminDb, companyId, 'fail-noprogress-admin-1', { role: 'admin', email: 'noprogress-admin@example.com' })

    const db = getTestFunctionsDb()
    const staleCutoff = Timestamp.fromMillis(Date.now() - 61 * 60 * 1000)

    // First claim: no baseline yet — seeds it, claims, does not count.
    const first = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(first).toBe('claimed')
    let ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.leaseProgressUnits).toBe(3)
    expect(ledger.noProgressResumes ?? 0).toBe(0)

    // Reset the heartbeat to stale again (as if another 61 minutes passed
    // with the purge still not moving) before each subsequent claim.
    await adminDb.doc(`companyDeletions/${requestId}`).update({ lastHeartbeatAt: staleHeartbeat })
    const second = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(second).toBe('claimed')
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes).toBe(1)
    expect(ledger.state).toBe('executing')

    await adminDb.doc(`companyDeletions/${requestId}`).update({ lastHeartbeatAt: staleHeartbeat })
    const third = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(third).toBe('claimed')
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes).toBe(2)
    expect(ledger.state).toBe('executing')

    await adminDb.doc(`companyDeletions/${requestId}`).update({ lastHeartbeatAt: staleHeartbeat })
    const fourth = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(fourth).toBe('failed')
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')
    expect(ledger.failureReason).toBe('no_progress')
    expect(ledger.noProgressResumes).toBe(3)

    const companySnap = (await adminDb.doc(`companies/${companyId}`).get()).data()!
    expect(companySnap.deletion.state).toBe('failed')

    const mailSnap = await adminDb.collection('mail').where('template', '==', 'companyDeletionFailed').where('companyId', '==', companyId).get()
    expect(mailSnap.size).toBe(1)
  })

  it('progress moving resets the no-progress counter', async () => {
    const companyId = 'fail-progressreset-co'
    const requestId = 'fail-progressreset-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await markExecuting(companyId, requestId, {
      progressUnits: 10,
      leaseProgressUnits: 4, // moved since the baseline
      leaseAttempts: 0,
      attempts: 0,
      noProgressResumes: 2, // one more resume would have tripped the limit
      lastHeartbeatAt: Timestamp.fromMillis(Date.now() - 62 * 60 * 1000),
    })

    const db = getTestFunctionsDb()
    const staleCutoff = Timestamp.fromMillis(Date.now() - 61 * 60 * 1000)

    const outcome = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(outcome).toBe('claimed')

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes).toBe(0)
    expect(ledger.leaseProgressUnits).toBe(10)
    expect(ledger.state).toBe('executing')
  })

  it('an attempts change (a phase threw and was caught normally) is not counted, but refreshes the attempts baseline', async () => {
    const companyId = 'fail-attemptschange-co'
    const requestId = 'fail-attemptschange-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await markExecuting(companyId, requestId, {
      progressUnits: 5,
      leaseProgressUnits: 5, // unchanged
      leaseAttempts: 0,
      attempts: 1, // changed since the baseline — a phase threw and was caught
      noProgressResumes: 2,
      lastHeartbeatAt: Timestamp.fromMillis(Date.now() - 62 * 60 * 1000),
    })

    const db = getTestFunctionsDb()
    const staleCutoff = Timestamp.fromMillis(Date.now() - 61 * 60 * 1000)

    const outcome = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(outcome).toBe('claimed')

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    // Neither reset to 0 (not proven progress) nor incremented (not proven
    // stuck either) — left exactly as it was.
    expect(ledger.noProgressResumes).toBe(2)
    expect(ledger.leaseAttempts).toBe(1) // baseline refreshed for the NEXT comparison
    expect(ledger.state).toBe('executing')
  })

  it('a legacy row with no lease baseline seeds one instead of counting the first stale hit', async () => {
    const companyId = 'fail-legacy-co'
    const requestId = 'fail-legacy-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    // Deliberately does NOT go through markExecuting's extra fields — this
    // row predates leaseProgressUnits/leaseAttempts/noProgressResumes
    // existing at all, the exact shape a pre-migration ledger has.
    await adminDb.doc(`companies/${companyId}`).update({ 'deletion.state': 'executing' })
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      state: 'executing',
      lastHeartbeatAt: Timestamp.now(),
      progressUnits: 7,
      attempts: 2,
    })

    const db = getTestFunctionsDb()
    const staleCutoff = Timestamp.fromMillis(Date.now() - 61 * 60 * 1000)
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      lastHeartbeatAt: Timestamp.fromMillis(Date.now() - 62 * 60 * 1000),
    })

    const outcome = await claimStaleLease(db, requestId, staleCutoff, FunctionsTimestamp.now())
    expect(outcome).toBe('claimed')

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.leaseProgressUnits).toBe(7)
    expect(ledger.leaseAttempts).toBe(2)
    // Not counted — no noProgressResumes field was ever written by this call.
    expect('noProgressResumes' in ledger).toBe(false)
  })
})

describe('company deletion failure — sweep wiring', () => {
  it('resumeStuck does not call runCompanyPurge when claimStaleLease reports the row failed', async () => {
    const companyId = 'fail-sweepwiring-co'
    const requestId = 'fail-sweepwiring-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await markExecuting(companyId, requestId, {
      progressUnits: 1,
      leaseProgressUnits: 1,
      leaseAttempts: 0,
      attempts: 0,
      noProgressResumes: 2, // this sweep's claim is the third
      lastHeartbeatAt: Timestamp.fromMillis(Date.now() - 61 * 60 * 1000),
    })
    await seedMember(adminDb, companyId, 'fail-sweepwiring-admin-1', { role: 'admin', email: 'sweepwiring-admin@example.com' })

    const db = getTestFunctionsDb()
    const result = await runCompanyDeletionSweep(db)

    expect(result.failedNoProgress).toBe(1)
    expect(result.resumed).toBe(0)

    const ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')
    expect(ledger.failureReason).toBe('no_progress')

    // Structural proof the purge itself never ran: the company document
    // (which only 'finalize' ever deletes) is still there.
    expect((await adminDb.doc(`companies/${companyId}`).get()).exists).toBe(true)
  })
})

describe('company deletion failure — subtree heartbeat under a large collection', () => {
  it('a subtree with >500 documents bumps progressUnits at least once more than an equivalent small one', async () => {
    const smallCompanyId = 'fail-subtree-small-co'
    const smallRequestId = 'fail-subtree-small-req'
    const bigCompanyId = 'fail-subtree-big-co'
    const bigRequestId = 'fail-subtree-big-req'

    // Both start from the SAME point (stripe/invitations/members already
    // done, no members) so the only variable between them is how many
    // documents the subtree phase's recursiveDelete has to walk through —
    // isolating the BulkWriter's own 500-write heartbeat from every other
    // source of progressUnits (which is identical between the two).
    await seedRequestedDeletion(adminDb, { companyId: smallCompanyId, requestId: smallRequestId, completedPhases: ['stripe', 'invitations', 'members'] })
    await markExecuting(smallCompanyId, smallRequestId)
    await seedMany(10, (i) => adminDb.doc(`companies/${smallCompanyId}/bookings/b${i}`), (i) => ({ title: `Booking ${i}` }))

    await seedRequestedDeletion(adminDb, { companyId: bigCompanyId, requestId: bigRequestId, completedPhases: ['stripe', 'invitations', 'members'] })
    await markExecuting(bigCompanyId, bigRequestId)
    await seedMany(550, (i) => adminDb.doc(`companies/${bigCompanyId}/bookings/b${i}`), (i) => ({ title: `Booking ${i}` }))

    const db = getTestFunctionsDb()
    await runCompanyPurge(db, smallRequestId)
    await runCompanyPurge(db, bigRequestId)

    const smallLedger = (await adminDb.doc(`companyDeletions/${smallRequestId}`).get()).data()!
    const bigLedger = (await adminDb.doc(`companyDeletions/${bigRequestId}`).get()).data()!
    expect(smallLedger.state).toBe('completed')
    expect(bigLedger.state).toBe('completed')

    // 550 crosses the 500-write heartbeat threshold exactly once; 10 never
    // reaches it. Every other contributor to progressUnits (per-collection
    // subtree bumps, orphans, markPhaseComplete x2) is identical between
    // the two runs, so the difference is exactly this one extra bump.
    expect(bigLedger.progressUnits).toBe((smallLedger.progressUnits as number) + 1)

    expect((await adminDb.doc(`companies/${smallCompanyId}/bookings/b0`).get()).exists).toBe(false)
    expect((await adminDb.doc(`companies/${bigCompanyId}/bookings/b0`).get()).exists).toBe(false)
    expect((await adminDb.doc(`companies/${bigCompanyId}/bookings/b549`).get()).exists).toBe(false)
  })
})

describe('company deletion failure — finalize heartbeat per chunk (review fix)', () => {
  it('every finalize mail-chunk commit bumps lastHeartbeatAt in the SAME write as progressUnits', async () => {
    // Review finding: runFinalizePhase's commitChunk bumped progressUnits
    // per chunk but not lastHeartbeatAt. A finalize phase with enough former
    // members to need >1 chunk (BATCH_LIMIT = 490) could legitimately run
    // past the 60-minute stale-lease window between chunks — progressUnits
    // moving only resets claimStaleLease's counter at its NEXT check, it
    // doesn't stop the row from being found stale (and resumed a second
    // time, concurrently) in the meantime, which is exactly the duplicate
    // 'companyDeleted' mail risk finalize's in-memory mailedUids tracking
    // cannot defend against on its own (it is not transactional across two
    // concurrent invocations).
    //
    // Asserted directly on the batch.update() call the phase makes, not on
    // the final ledger state — the ledger's heartbeat ends up fresh
    // regardless (purge.ts's own catch block also refreshes it on ANY
    // thrown error), so checking only the end state would pass even if this
    // specific write never included lastHeartbeatAt at all.
    const companyId = 'fail-finalize-heartbeat-co'
    const requestId = 'fail-finalize-heartbeat-req'
    const CONTACT_COUNT = 500 // > BATCH_LIMIT (490) forces exactly 2 chunks

    const contacts = Array.from({ length: CONTACT_COUNT }, (_, i) => ({
      uid: `finalize-hb-uid-${i}`,
      name: `Member ${i}`,
      email: `finalize-hb-${i}@example.com`,
      accountStatus: 'kept' as const,
    }))

    await seedRequestedDeletion(adminDb, {
      companyId,
      requestId,
      completedPhases: ['stripe', 'invitations', 'members', 'subtree', 'orphans'],
    })
    await markExecuting(companyId, requestId)
    await adminDb.doc(`companyDeletions/${requestId}`).update({ formerMemberContacts: contacts })

    const db = getTestFunctionsDb()
    const ledgerPath = `companyDeletions/${requestId}`
    const capturedLedgerUpdates: Record<string, unknown>[] = []

    const realBatch = db.batch.bind(db)
    const batchSpy = vi.spyOn(db, 'batch').mockImplementation(() => {
      const batch = realBatch()
      const realUpdate = batch.update.bind(batch)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(batch as any).update = (ref: FirebaseFirestore.DocumentReference, data: Record<string, unknown>) => {
        if (ref.path === ledgerPath) capturedLedgerUpdates.push(data)
        return realUpdate(ref, data)
      }
      return batch
    })

    await runCompanyPurge(db, requestId)
    batchSpy.mockRestore()

    const ledger = (await adminDb.doc(ledgerPath).get()).data()!
    expect(ledger.state).toBe('completed')

    // Exactly 2 chunk commits for 500 contacts at a 490-per-batch limit.
    const finalizeChunkUpdates = capturedLedgerUpdates.filter((u) => 'finalizeMailQueuedUids' in u)
    expect(finalizeChunkUpdates.length).toBe(2)
    for (const update of finalizeChunkUpdates) {
      expect(update).toHaveProperty('progressUnits')
      expect(update).toHaveProperty('lastHeartbeatAt')
    }

    const mailSnap = await adminDb.collection('mail').where('template', '==', 'companyDeleted').get()
    expect(mailSnap.size).toBe(CONTACT_COUNT)
  })
})

describe('company deletion failure — alternating failure modes eventually terminate in failed', () => {
  it('a mix of SIGKILL-style no-progress stale claims and normal caught throws still reaches failed', async () => {
    // Neither mechanism has to do all the work alone. A purge can flicker
    // between "the process got SIGKILLed with no chance to record anything"
    // (claimStaleLease's no-progress detection, issue #335) and "a phase
    // threw and purge.ts's own catch block recorded it normally" (an
    // ordinary attempts bump) many times over its life. Whatever the mix,
    // the row must not be able to sit in 'executing' forever — one of the
    // two budgets (NO_PROGRESS_LIMIT or MAX_ATTEMPTS) always closes it out.
    const companyId = 'fail-alternating-co'
    const requestId = 'fail-alternating-req'

    await seedRequestedDeletion(adminDb, {
      companyId,
      requestId,
      completedPhases: ['stripe', 'invitations', 'members'], // next real phase: subtree
    })
    await markExecuting(companyId, requestId)

    const db = getTestFunctionsDb()
    const staleCutoff = () => Timestamp.fromMillis(Date.now() - 61 * 60 * 1000)
    const backdateHeartbeat = () =>
      adminDb.doc(`companyDeletions/${requestId}`).update({ lastHeartbeatAt: Timestamp.fromMillis(Date.now() - 62 * 60 * 1000) })

    // Stale claim #1: no lease baseline yet — seeds it, 'claimed', not counted.
    await backdateHeartbeat()
    const claim1 = await claimStaleLease(db, requestId, staleCutoff(), FunctionsTimestamp.now())
    expect(claim1).toBe('claimed')
    let ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes ?? 0).toBe(0)

    // A normal caught throw: one phase attempt fails for an ordinary reason
    // (not a SIGKILL) and purge.ts's own catch block runs to completion,
    // recording attempts = 1. Budget nowhere near exhausted (MAX_ATTEMPTS = 5).
    const throwSpy = vi.spyOn(db, 'recursiveDelete').mockImplementationOnce(() => {
      throw new Error('simulated ordinary phase failure (not a SIGKILL)')
    })
    await runCompanyPurge(db, requestId)
    throwSpy.mockRestore()
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.attempts).toBe(1)
    expect(ledger.state).toBe('executing') // budget not exhausted

    // Stale claim #2: attempts moved (0 -> 1) since the lease baseline —
    // "something happened", so the no-progress counter is left alone, but
    // the attempts baseline refreshes to 1 for the NEXT comparison.
    await backdateHeartbeat()
    const claim2 = await claimStaleLease(db, requestId, staleCutoff(), FunctionsTimestamp.now())
    expect(claim2).toBe('claimed')
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes ?? 0).toBe(0)
    expect(ledger.leaseAttempts).toBe(1)

    // From here on, SIGKILL-style: three consecutive stale claims with
    // NEITHER progressUnits nor attempts moving at all — the exact pattern a
    // phase that times out on every single invocation produces (issue #335).
    await backdateHeartbeat()
    const claim3 = await claimStaleLease(db, requestId, staleCutoff(), FunctionsTimestamp.now())
    expect(claim3).toBe('claimed')
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes).toBe(1)
    expect(ledger.state).toBe('executing')

    await backdateHeartbeat()
    const claim4 = await claimStaleLease(db, requestId, staleCutoff(), FunctionsTimestamp.now())
    expect(claim4).toBe('claimed')
    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.noProgressResumes).toBe(2)
    expect(ledger.state).toBe('executing')

    await backdateHeartbeat()
    const claim5 = await claimStaleLease(db, requestId, staleCutoff(), FunctionsTimestamp.now())
    expect(claim5).toBe('failed')

    ledger = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(ledger.state).toBe('failed')
    expect(ledger.failureReason).toBe('no_progress')
    // The one caught throw from earlier is still on the record — this path
    // to 'failed' didn't erase or reset it.
    expect(ledger.attempts).toBe(1)

    const companySnap = (await adminDb.doc(`companies/${companyId}`).get()).data()!
    expect(companySnap.deletion.state).toBe('failed')
  })
})
