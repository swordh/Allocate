'use server'

import { getVerifiedSession } from '@/lib/dal'
import { adminDb } from '@/lib/firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { FEEDBACK_TYPES, type FeedbackType, type FeedbackStatus, type FeedbackPriority } from '@/types/operator'

export type SubmitFeedbackResult = { ticketId: string } | { error: string }

// Legacy ticket IDs (pre-#424) used `${prefix}-${random 1000-9999}`, so every
// ticket ever written before this change falls in that range. Starting the
// shared counter at 10000 guarantees a new sequential id can never collide
// with an old random one — no backfill/migration of existing tickets needed.
const TICKET_NUMBER_START = 10000

export async function submitFeedback(data: {
  type: FeedbackType
  title: string
  description: string
}): Promise<SubmitFeedbackResult> {
  try {
    const session = await getVerifiedSession()
    const { uid, activeCompanyId } = session

    // Validate
    if (!data.title.trim() || data.title.trim().length > 200) return { error: 'Invalid title' }
    if (!data.description.trim() || data.description.trim().length > 2000) return { error: 'Invalid description' }
    // TypeScript's `type: FeedbackType` param isn't a runtime guard — the
    // client can send any string. Without this check an unexpected value
    // would fall through the prefix logic below (its ternary's else branch
    // silently returns 'SUP') and get written straight into operatorFeedback.
    if (!FEEDBACK_TYPES.includes(data.type)) return { error: 'Invalid type' }

    // Fetch user name + company name in parallel
    const [userSnap, companySnap] = await Promise.all([
      adminDb.doc(`users/${uid}`).get(),
      adminDb.doc(`companies/${activeCompanyId}`).get(),
    ])
    const userName = (userSnap.data()?.name as string) ?? session.email
    const companyName = (companySnap.data()?.name as string) ?? activeCompanyId

    // Generate human-readable ticket ID (#424): a single sequential counter
    // shared across all three prefixes, not a random suffix per prefix — the
    // old `Math.random()*9000+1000` gave each prefix only 9000 ids, so every
    // submit had an n/9000 chance of hitting one of the n tickets already
    // under that prefix, and a collision silently overwrote another user's
    // ticket (including detaching its `notes` subcollection, which stayed
    // pointed at the now-overwritten doc, and clearing `closedAt`, which
    // could hide the ticket from purgeOldFeedback's retention sweep
    // forever). The counter lives at `counters/operatorFeedback`, a
    // dedicated top-level doc, rather than inside `operatorFeedback` itself
    // — that collection is iterated wholesale in several places
    // (purge.ts's ORPHAN_COLLECTIONS, purgeOldFeedback's `closedAt` range
    // query, actions/account.ts's and actions/team.ts's `submittedBy == uid`
    // queries) and none of them expect a non-ticket doc mixed in.
    const prefix = data.type === 'bug_report' ? 'BUG' : data.type === 'feature_request' ? 'FEA' : 'SUP'
    const counterRef = adminDb.doc('counters/operatorFeedback')

    const ticketId = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef)
      // Created lazily on first submit rather than backfilled — every
      // environment's counter starts fresh at TICKET_NUMBER_START the first
      // time this runs there, and since that's already clear of every
      // legacy random id, there's nothing to migrate in any of the four
      // environments.
      const n = (snap.data()?.next as number | undefined) ?? TICKET_NUMBER_START
      const id = `${prefix}-${n}`
      tx.set(counterRef, { next: n + 1 })
      // `tx.create`, not `.set()` — belt and braces on top of the counter
      // itself already making a collision impossible: `create` throws
      // ALREADY_EXISTS instead of silently overwriting if `id` somehow
      // exists already, so a bug here fails loudly (falls to the catch
      // below, "Failed to submit") rather than reattaching another user's
      // ticket to this submission's notes. Firestore retries the whole
      // transaction automatically on contention (e.g. two submits racing
      // for the same counter value), so this isn't itself a source of
      // spurious failures.
      tx.create(adminDb.collection('operatorFeedback').doc(id), {
        type: data.type,
        title: data.title.trim(),
        description: data.description.trim(),
        submittedAt: FieldValue.serverTimestamp(),
        submittedBy: uid,
        companyId: activeCompanyId,
        companyName,
        userName,
        status: 'open' as FeedbackStatus,
        priority: 'medium' as FeedbackPriority,
      })
      return id
    })

    return { ticketId }
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? ''
    const msg = err instanceof Error ? err.message : ''
    if (digest.startsWith('NEXT_REDIRECT') || msg.startsWith('REDIRECT:')) throw err
    console.error('[submitFeedback] error', err)
    return { error: 'Failed to submit. Please try again.' }
  }
}
