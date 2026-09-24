/**
 * What the mail paths do with a ledger whose identity has been redacted —
 * issue #252 step 5, PR G.
 *
 * `requestedByName` became `string | null` when the 24-month retention job
 * started writing null into it. The compiler pointed at nothing, because both
 * places that feed it into an email do so through untyped object literals
 * written straight to `mail/{id}`. The stance those two sites now take is
 * `?? 'An administrator'`, and this file is the reason that is a decision
 * rather than a hopeful line: without it, deleting either `??` breaks no test,
 * and the production failure is an email that says "null asked for Acme Film
 * AB to be deleted" — or no email at all, if `escapeHtml(null)` throws first.
 *
 * Unreachable in practice today (redaction lands two years after the request,
 * on a row that went terminal within days), which is precisely why it needs a
 * test: nobody will ever notice it by hand.
 */
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { handleCompanyDeletionCreated } from '../../functions/src/company/onDeletionCreated'
import { runCompanyPurge } from '../../functions/src/company/purge'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import { seedRequestedDeletion, seedMember } from './companyDeletionFixtures'

describe('mail built from a redacted ledger', () => {
  it('the deletion-requested trigger names "An administrator", never null', async () => {
    const companyId = 'redacted-req-co'
    const requestId = 'redacted-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId })
    await seedMember(adminDb, companyId, 'redacted-admin-1', {
      email: 'redactedadmin@example.com',
      role: 'admin',
    })
    // The row as the retention job leaves it.
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      requestedByUid: null,
      requestedByName: null,
      requestedByEmail: null,
      identityRedactedAt: new Date(),
    })

    const db = getTestFunctionsDb()
    // Read through functions/'s OWN Firestore, not the root project's
    // `adminDb`: the trigger mints a cancel token whose `expiresAt` it copies
    // straight off this snapshot, and the Admin SDK refuses a Timestamp
    // instance that came from a different copy of firebase-admin. (The
    // immediate-mode call in companyDeletionLease.emulator.ts gets away with
    // `adminDb` only because that branch mints no token.)
    const ledgerSnap = await db.doc(`companyDeletions/${requestId}`).get()
    await handleCompanyDeletionCreated(
      db,
      requestId,
      ledgerSnap.data() as Parameters<typeof handleCompanyDeletionCreated>[2],
    )

    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeletionRequested')
      .get()
    expect(mailSnap.size).toBe(1)
    const data = mailSnap.docs[0].data()['data'] as Record<string, unknown>
    expect(data['requestedByName']).toBe('An administrator')
    // Not the string "null", and not missing either — Firestore rejects
    // `undefined` outright, so a plain pass-through would have failed the
    // write and lost the mail entirely.
    expect(data['requestedByName']).not.toBe('null')
  })

  it('the companyDeleted mail names "An administrator", never null', async () => {
    const companyId = 'redacted-purge-co'
    const requestId = 'redacted-purge-req'

    await seedRequestedDeletion(adminDb, { companyId, requestId, state: 'executing' })
    await seedMember(adminDb, companyId, 'redacted-member-1', { email: 'redactedmember@example.com' })
    await adminDb.doc(`companyDeletions/${requestId}`).update({
      requestedByUid: null,
      requestedByName: null,
      requestedByEmail: null,
      identityRedactedAt: new Date(),
    })

    await runCompanyPurge(getTestFunctionsDb(), requestId)

    const mailSnap = await adminDb
      .collection('mail')
      .where('template', '==', 'companyDeleted')
      .where('to', '==', 'redactedmember@example.com')
      .get()
    expect(mailSnap.size).toBe(1)
    const data = mailSnap.docs[0].data()['data'] as Record<string, unknown>
    expect(data['requestedByName']).toBe('An administrator')
    expect(data['requestedByName']).not.toBe('null')
  })
})
