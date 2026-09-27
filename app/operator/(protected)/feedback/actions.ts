'use server'
import { getOperatorSession, rethrowRedirect } from '@/lib/operator-dal'
import { adminDb } from '@/lib/firebase-admin'
import { revalidatePath } from 'next/cache'
import { FieldValue } from 'firebase-admin/firestore'
import type { FeedbackStatus, FeedbackPriority } from '@/types/operator'
import { CLOSED_FEEDBACK_STATUSES, FEEDBACK_STATUS_LABELS, FEEDBACK_PRIORITY_LABELS } from '@/types/operator'

// issue #338 PR 2: whether a (possibly undefined — a doc that predates the
// `status` field entirely) status counts as "closed" for `closedAt`
// purposes. `undefined` is never closed — there is nothing to have closed
// FROM — which is what makes an undefined-to-closed transition below set
// `closedAt` rather than silently skip it.
function isClosedStatus(status: FeedbackStatus | undefined): boolean {
  return status !== undefined && CLOSED_FEEDBACK_STATUSES.includes(status)
}

// Single home for both status/priority setters and the note composer — used
// by both the list screen's right panel (app/operator/feedback) and the
// detail screen's aside (app/operator/feedback/[id]). Kept here rather than
// under [id] because the shallower path can be imported by both pages; the
// reverse would make the list page depend on a dynamic child segment.
function revalidateFeedback(id: string) {
  revalidatePath('/operator/feedback')
  revalidatePath(`/operator/feedback/${id}`)
}

export async function updateFeedbackStatus(
  id: string, status: FeedbackStatus
): Promise<{ error?: string }> {
  try {
    const session = await getOperatorSession()
    const ref = adminDb.doc(`operatorFeedback/${id}`)
    const snap = await ref.get()
    if (!snap.exists) return { error: 'Feedback not found' }
    const from = snap.data()?.status as FeedbackStatus | undefined

    if (from !== status) {
      const wasClosed = isClosedStatus(from)
      const willBeClosed = isClosedStatus(status)

      // issue #338 PR 2 (retention): `closedAt` marks the 24-month clock
      // functions/src/admin/purgeOldFeedback.ts reads. Set on an open-ish →
      // closed transition (including from `undefined`, i.e. a doc that
      // predates `status` entirely — closing it now starts the clock same
      // as any other closure), cleared on closed → open-ish (a reopened
      // ticket is not retired), and left untouched on closed → closed
      // (`done` ↔ `wont_fix` — the ticket has been closed the whole time,
      // so its original closedAt should keep governing retention).
      const closedAtUpdate = willBeClosed && !wasClosed
        ? { closedAt: FieldValue.serverTimestamp() }
        : !willBeClosed && wasClosed
          ? { closedAt: FieldValue.delete() }
          : {}

      const batch = adminDb.batch()
      batch.update(ref, { status, ...closedAtUpdate })
      // Only write an event when the value actually changes, and only once
      // we know what it changed FROM — an explicit ?? would fabricate a
      // "changed from itself" line for the (should-never-happen) case where
      // the doc predates the status field entirely.
      if (from) {
        batch.set(ref.collection('notes').doc(), {
          kind: 'event',
          text: `Status changed ${FEEDBACK_STATUS_LABELS[from]} → ${FEEDBACK_STATUS_LABELS[status]}`,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: session.email,
        })
      }
      await batch.commit()
    }

    revalidateFeedback(id)
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to update status' }
  }
}

export async function updateFeedbackPriority(
  id: string, priority: FeedbackPriority
): Promise<{ error?: string }> {
  try {
    const session = await getOperatorSession()
    const ref = adminDb.doc(`operatorFeedback/${id}`)
    const snap = await ref.get()
    if (!snap.exists) return { error: 'Feedback not found' }
    const from = snap.data()?.priority as FeedbackPriority | undefined

    if (from !== priority) {
      const batch = adminDb.batch()
      batch.update(ref, { priority })
      if (from) {
        batch.set(ref.collection('notes').doc(), {
          kind: 'event',
          text: `Priority changed ${FEEDBACK_PRIORITY_LABELS[from]} → ${FEEDBACK_PRIORITY_LABELS[priority]}`,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: session.email,
        })
      }
      await batch.commit()
    }

    revalidateFeedback(id)
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to update priority' }
  }
}

// Writes a `kind: 'note'` entry to the same timeline subcollection the
// status/priority actions above write `kind: 'event'` entries to — see
// types/operator.ts's FeedbackTimelineEntry doc comment for why this is one
// collection, not two.
export async function addFeedbackNote(
  id: string, text: string
): Promise<{ error?: string }> {
  try {
    const session = await getOperatorSession()
    const trimmed = text.trim()
    if (!trimmed) return { error: 'Note is empty' }
    await adminDb.collection(`operatorFeedback/${id}/notes`).add({
      kind: 'note',
      text: trimmed,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: session.email,
    })
    revalidateFeedback(id)
    return {}
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Failed to add note' }
  }
}
