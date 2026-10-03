'use server'
import { revalidatePath } from 'next/cache'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { getOperatorSession, rethrowRedirect, type OperatorSession } from '@/lib/operator-dal'
import { REGISTRATION_DOC_PATH } from '@/lib/registrationFlags'

export type RegistrationSwitch = 'accounts' | 'companies'

const SWITCHES: readonly RegistrationSwitch[] = ['accounts', 'companies']

const MIN_REASON_LENGTH = 3
/** Same 500-character bar as every other operator free-text field (actions/operatorCompanyDeletion.ts MAX_NOTE_LENGTH). */
const MAX_REASON_LENGTH = 500

export interface SetRegistrationFlagResult {
  ok?: true
  /** True when the switch already had the requested value — nothing written, nothing logged. */
  unchanged?: boolean
  error?: string
}

/**
 * Flips one of the two registration kill switches and writes an audit-log
 * entry in the same transaction.
 *
 * Operator-only (`getOperatorSession` — provider claim AND email allowlist);
 * nothing else can write `system/**` because firestore.rules denies every
 * client access. The reason is required (>= 3 chars after trimming).
 *
 * Account blocking is enforced in the UI only (signup page); company
 * creation is also enforced server-side in `setupNewCompany`.
 */
export async function setRegistrationFlag(
  which: RegistrationSwitch,
  value: boolean,
  reason: string,
): Promise<SetRegistrationFlagResult> {
  let session: OperatorSession
  try {
    session = await getOperatorSession()
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Not authorized.' }
  }

  if (!SWITCHES.includes(which)) return { error: 'Unknown switch.' }
  if (typeof value !== 'boolean') return { error: 'Invalid value.' }
  if (typeof reason !== 'string') return { error: 'A reason is required.' }
  const trimmedReason = reason.trim().slice(0, MAX_REASON_LENGTH)
  if (trimmedReason.length < MIN_REASON_LENGTH) {
    return { error: `Give a reason of at least ${MIN_REASON_LENGTH} characters.` }
  }

  const flagField = which === 'accounts' ? 'accountsBlocked' : 'companiesBlocked'
  const sinceField = which === 'accounts' ? 'accountsBlockedSince' : 'companiesBlockedSince'

  try {
    const flagsRef = adminDb.doc(REGISTRATION_DOC_PATH)
    let changed = false

    await adminDb.runTransaction(async (tx) => {
      // Reset on every attempt — a retried transaction must not carry a
      // result over from an aborted one.
      changed = false

      const snap = await tx.get(flagsRef)
      const current = snap.exists && snap.data()?.[flagField] === true
      if (current === value) return

      tx.set(
        flagsRef,
        {
          [flagField]: value,
          [sinceField]: value ? FieldValue.serverTimestamp() : null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      tx.set(flagsRef.collection('log').doc(), {
        switch: which,
        newValue: value,
        operatorUid: session.uid,
        reason: trimmedReason,
        at: FieldValue.serverTimestamp(),
      })
      changed = true
    })

    if (!changed) return { ok: true, unchanged: true }

    // No reason text in the log line — it is free text the operator typed.
    console.log('[operator/system]', {
      action: 'registration_flag_set',
      switch: which,
      newValue: value,
      operatorUid: session.uid,
    })

    revalidatePath('/operator/system')
    revalidatePath('/signup')
    revalidatePath('/no-company')
    return { ok: true }
  } catch (err) {
    rethrowRedirect(err)
    console.error('[operator/system]', {
      action: 'registration_flag_set_failed',
      switch: which,
      error: err instanceof Error ? err.message : String(err),
    })
    return { error: 'Could not save the change. Please try again.' }
  }
}
