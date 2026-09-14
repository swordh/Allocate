/**
 * Retention rule two — issue #252 step 5, PR G. `formerMemberContacts` is
 * every former member's name and email, snapshotted by the purge's members
 * phase. It is NOT carried by the Art. 17(3)(e) basis that covers the person
 * who requested the deletion, so it goes on its own, much shorter clock: 30
 * days after `completedAt`, and 90 days after a `failed` row's last
 * heartbeat. Both replace the list with an anonymous aggregate rather than
 * deleting the row. See the constants and their derivations in
 * functions/src/company/purgeLogs.ts.
 *
 * The guard this file exists to protect: `formerMemberContacts` doubles as
 * the members phase's RESUME MARKER, so redacting a row that is still
 * `requested`/`executing` would make a resumed purge re-process members it
 * had already finished. Non-terminal rows must be untouchable, and both the
 * in-code check (completed rule) and the query-level one (failed rule) are
 * tested separately below.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { purgeCompanyDeletionLogsSweep } from '../../functions/src/company/purgeLogs'
import { expectOnlyTheseFieldsChanged } from './redactionAssertions'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'

const DAY = 24 * 60 * 60 * 1000
const past = (days: number) => Timestamp.fromMillis(Date.now() - days * DAY)
const future = (days: number) => Timestamp.fromMillis(Date.now() + days * DAY)

const CONTACTS = [
  { uid: 'u1', name: 'Anna Admin', email: 'anna@example.com', accountStatus: 'kept' },
  { uid: 'u2', name: 'Bo Crew', email: 'bo@example.com', accountStatus: 'scheduled', pendingDeletionScheduledFor: future(12) },
  { uid: 'u3', name: 'Cilla Crew', email: 'cilla@example.com', accountStatus: 'scheduled', pendingDeletionScheduledFor: future(12) },
  { uid: 'u4', name: 'Dan Gone', email: 'dan@example.com', accountStatus: 'already_gone' },
]

/**
 * A ledger row shaped like whatever state the test needs. `purgeAfter` is
 * deliberately far in the future on every row here, so anything that happens
 * to these rows is the contacts rules' doing and never the identity rule's.
 */
function ledgerRow(opts: {
  requestId: string
  state: string
  completedAt?: Timestamp
  lastHeartbeatAt?: Timestamp
  withContacts?: boolean
  /** Seeds ONLY `finalizeMailQueuedUids` — the half of the guard no other fixture covers. */
  uidsOnly?: boolean
}) {
  return {
    requestId: opts.requestId,
    companyId: `co-${opts.requestId}`,
    companyName: 'Acme Film AB',
    mode: 'window',
    state: opts.state,
    requestedAt: past(60),
    requestedByUid: 'requester-uid',
    requestedByName: 'Requester Name',
    requestedByEmail: 'requester@example.com',
    scheduledFor: past(53),
    attempts: opts.state === 'failed' ? 5 : 0,
    purgeAfter: future(600),
    ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
    ...(opts.lastHeartbeatAt ? { lastHeartbeatAt: opts.lastHeartbeatAt } : {}),
    ...(opts.uidsOnly
      ? { finalizeMailQueuedUids: ['u1', 'u2', 'u3', 'u4'] }
      : opts.withContacts === false
        ? {}
        : {
            formerMemberContacts: CONTACTS,
            finalizeMailQueuedUids: ['u1', 'u2', 'u3', 'u4'],
          }),
  }
}

describe('purgeCompanyDeletionLogsSweep — formerMemberContacts retention', () => {
  it('replaces contacts with an anonymous summary 30 days after completedAt, and clears finalizeMailQueuedUids in the same write', async () => {
    const requestId = 'done-old'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'completed', completedAt: past(40) }),
    )
    const before = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_completed'].redacted).toBe(1)
    expect(result.failedBatches).toBe(0)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    // Key-set diff, not a list of survivors: only these two keys may go, only
    // these two may arrive, and nothing else may move. `purgeAfter` is the
    // reason this is worth the ceremony — if a contacts redaction ever removed
    // it, the row would fall out of the identity rule's range query for good
    // (Firestore skips documents missing the compared field) and the
    // requester's name, address and uid would be kept forever, silently.
    expectOnlyTheseFieldsChanged(before, after, {
      mayChange: ['formerMemberContacts', 'finalizeMailQueuedUids'],
      mayAppear: ['formerMemberSummary', 'contactsRedactedAt'],
    })

    // Both per-uid lists gone outright — not nulled. `formerMemberSummary`
    // plus the marker already say "this was redacted"; there is no
    // never-existed case to keep distinguishable here.
    expect('formerMemberContacts' in after).toBe(false)
    expect('finalizeMailQueuedUids' in after).toBe(false)

    // The aggregate carries the whole of what the operator view needs.
    expect(after.formerMemberSummary).toEqual({ total: 4, kept: 1, scheduled: 2, already_gone: 1 })
    expect(after.contactsRedactedAt).toBeInstanceOf(Timestamp)

    // No name, no address, no uid survives anywhere on the row.
    const serialized = JSON.stringify(after)
    for (const needle of ['anna@example.com', 'bo@example.com', 'cilla@example.com', 'dan@example.com', 'Anna Admin', 'Bo Crew', '"u1"', '"u4"']) {
      expect(serialized).not.toContain(needle)
    }

    // The two rules run on independent clocks: this row's 24-month identity
    // deadline is nowhere near, and the identity is untouched.
    expect(after.requestedByName).toBe('Requester Name')
    expect('identityRedactedAt' in after).toBe(false)

    // Everything that is not a contact list is still there.
    expect(after.companyName).toBe('Acme Film AB')
    expect(after.state).toBe('completed')
    expect(after.completedAt).toBeInstanceOf(Timestamp)
  })

  it('leaves a company deleted 10 days ago alone — the window is 30 days, not "completed"', async () => {
    const requestId = 'done-recent'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'completed', completedAt: past(10) }),
    )

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_completed'].eligible).toBe(0)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.formerMemberContacts).toHaveLength(4)
    expect(after.finalizeMailQueuedUids).toHaveLength(4)
    expect('contactsRedactedAt' in after).toBe(false)
  })

  it('NEVER touches a non-terminal row, even one carrying an old completedAt', async () => {
    // Deliberately impossible in production — `completedAt` is written on one
    // line in purge.ts, together with `state: 'completed'`. Constructed here
    // precisely because the in-code state check is the only thing standing
    // between this job and a live purge's members-phase resume marker, and a
    // guard that cannot be observed failing is not a tested guard.
    const requestId = 'executing-with-completedat'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'executing', completedAt: past(40) }),
    )

    await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.formerMemberContacts).toHaveLength(4)
    expect(after.finalizeMailQueuedUids).toHaveLength(4)
    expect('contactsRedactedAt' in after).toBe(false)
    expect('formerMemberSummary' in after).toBe(false)
  })

  it('redacts a failed row 90 days after its last heartbeat', async () => {
    const requestId = 'failed-old'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'failed', lastHeartbeatAt: past(100) }),
    )
    const before = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_failed'].redacted).toBe(1)
    expect(result.failedBatches).toBe(0)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expectOnlyTheseFieldsChanged(before, after, {
      mayChange: ['formerMemberContacts', 'finalizeMailQueuedUids'],
      mayAppear: ['formerMemberSummary', 'contactsRedactedAt'],
    })
    expect('formerMemberContacts' in after).toBe(false)
    expect('finalizeMailQueuedUids' in after).toBe(false)
    expect(after.formerMemberSummary).toEqual({ total: 4, kept: 1, scheduled: 2, already_gone: 1 })
    expect(after.contactsRedactedAt).toBeInstanceOf(Timestamp)
    // Still failed, still an open incident an operator can find.
    expect(after.state).toBe('failed')
    expect(after.attempts).toBe(5)
  })

  it('leaves a failed row alone at 40 days — the failed window is 90, not the completed rule\'s 30', async () => {
    const requestId = 'failed-recent'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'failed', lastHeartbeatAt: past(40) }),
    )

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_failed'].eligible).toBe(0)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.formerMemberContacts).toHaveLength(4)
  })

  it('leaves a STUCK executing row alone however old its heartbeat is', async () => {
    // The realistic version of the guard above: a purge that keeps timing out
    // never increments `attempts`, so it sits in `executing` with an ancient
    // heartbeat. It is still resumable, so its resume marker is off limits.
    const requestId = 'stuck-executing'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'executing', lastHeartbeatAt: past(400) }),
    )

    await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.formerMemberContacts).toHaveLength(4)
    expect('contactsRedactedAt' in after).toBe(false)
  })

  it('does not pick up a completed row that never carried contacts (a cancelled-then-completed shape)', async () => {
    const requestId = 'no-contacts'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'completed', completedAt: past(40), withContacts: false }),
    )

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_completed'].eligible).toBe(0)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    // No empty summary, no marker — nothing was redacted, so the row must not
    // claim anything was.
    expect('formerMemberSummary' in after).toBe(false)
    expect('contactsRedactedAt' in after).toBe(false)
  })

  it('runs the two clocks independently: a contacts-redacted row still gets identity-redacted when ITS deadline lands', async () => {
    const requestId = 'contacts-done-identity-due'
    const contactsMarker = past(370)
    await adminDb.doc(`companyDeletions/${requestId}`).set({
      ...ledgerRow({ requestId, state: 'completed', completedAt: past(400), withContacts: false }),
      // Already through rule two, months ago.
      formerMemberSummary: { total: 4, kept: 1, scheduled: 2, already_gone: 1 },
      contactsRedactedAt: contactsMarker,
      // And now past its own 24-month identity deadline.
      purgeAfter: past(1),
    })

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['identity'].redacted).toBe(1)
    expect(result.byRule['contacts_completed'].eligible).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.requestedByName).toBeNull()
    expect(after.identityRedactedAt).toBeInstanceOf(Timestamp)
    // Rule two's marker keeps its original value — it did not run again.
    expect(after.contactsRedactedAt).toEqual(contactsMarker)
    expect(after.formerMemberSummary).toEqual({ total: 4, kept: 1, scheduled: 2, already_gone: 1 })
  })

  it('picks up a row carrying ONLY finalizeMailQueuedUids, and writes no summary for it', async () => {
    // The other half of `carriesMemberContactData`. Without this fixture the
    // `|| Array.isArray(data['finalizeMailQueuedUids'])` half can be deleted
    // outright and every other test still passes — a guard claiming two fields
    // with one of them proven.
    const requestId = 'uids-only'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'completed', completedAt: past(40), uidsOnly: true }),
    )

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_completed'].redacted).toBe(1)
    expect(result.failedRows).toBe(0)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect('finalizeMailQueuedUids' in after).toBe(false)
    // And NO aggregate: there was no contact list to aggregate, and
    // `formerMemberSummary: { total: 0 }` would claim this deletion had no
    // members on a row that provably mailed four.
    expect('formerMemberSummary' in after).toBe(false)
    expect(after.contactsRedactedAt).toBeInstanceOf(Timestamp)
  })

  it('redacts contacts that COME BACK on an already-marked row', async () => {
    // Step 6 plans a "re-run" action for failed purges. A re-run whose
    // completedPhases lacks `members` runs the members phase again and writes
    // a fresh `formerMemberContacts` — names and addresses — onto a row that
    // already carries `contactsRedactedAt`. If the marker alone gated the
    // rule, that row would be immune to it forever: PII kept permanently by
    // the very field that records the PII was removed.
    const requestId = 'contacts-resurrected'
    const oldMarker = past(200)
    await adminDb.doc(`companyDeletions/${requestId}`).set({
      ...ledgerRow({ requestId, state: 'failed', lastHeartbeatAt: past(100) }),
      contactsRedactedAt: oldMarker,
      formerMemberSummary: { total: 4, kept: 1, scheduled: 2, already_gone: 1 },
    })

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['contacts_failed'].redacted).toBe(1)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect('formerMemberContacts' in after).toBe(false)
    expect('finalizeMailQueuedUids' in after).toBe(false)
    expect(JSON.stringify(after)).not.toContain('anna@example.com')
    // The marker moves — it now records the SECOND redaction, which is when
    // this row's identities actually went away.
    expect(after.contactsRedactedAt).not.toEqual(oldMarker)
  })

  it('redacts a row that is due for the identity rule AND a contacts rule in the same sweep', async () => {
    // The ordinary case the first time this job runs against an existing
    // ledger: every completed row older than two years is due for both. Also
    // pins the counting — this is ONE row, whatever the rules did to it.
    const requestId = 'due-for-both'
    await adminDb.doc(`companyDeletions/${requestId}`).set({
      ...ledgerRow({ requestId, state: 'completed', completedAt: past(800) }),
      purgeAfter: past(70),
    })

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.byRule['identity'].redacted).toBe(1)
    expect(result.byRule['contacts_completed'].redacted).toBe(1)
    // One row, not two. `eligible`/`redacted` count DISTINCT rows; only
    // `byRule` counts rule applications.
    expect(result.eligible).toBe(1)
    expect(result.redacted).toBe(1)

    const after = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(after.requestedByName).toBeNull()
    expect(after.identityRedactedAt).toBeInstanceOf(Timestamp)
    expect('formerMemberContacts' in after).toBe(false)
    expect(after.formerMemberSummary).toEqual({ total: 4, kept: 1, scheduled: 2, already_gone: 1 })
    expect(after.contactsRedactedAt).toBeInstanceOf(Timestamp)
  })

  it('is idempotent: a second sweep redacts nothing and changes nothing', async () => {
    const requestId = 'contacts-twice'
    await adminDb.doc(`companyDeletions/${requestId}`).set(
      ledgerRow({ requestId, state: 'completed', completedAt: past(40) }),
    )

    const db = getTestFunctionsDb()
    await purgeCompanyDeletionLogsSweep(db)
    const afterFirst = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!

    const second = await purgeCompanyDeletionLogsSweep(db)
    expect(second.byRule['contacts_completed'].eligible).toBe(0)
    expect(second.byRule['contacts_failed'].eligible).toBe(0)

    const afterSecond = (await adminDb.doc(`companyDeletions/${requestId}`).get()).data()!
    expect(afterSecond).toEqual(afterFirst)
  })
})
