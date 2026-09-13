import type { Firestore, QueryDocumentSnapshot, DocumentSnapshot } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { sendEmail, RenderedEmail } from './send';
import { classifyMailError, computeBackoffMs, MAX_MAIL_ATTEMPTS } from './mailRetry';
import { invitationEmail } from './templates/invitation';
import { verifyEmailEmail } from './templates/verifyEmail';
import { resetPasswordEmail } from './templates/resetPassword';
import { changeEmailEmail } from './templates/changeEmail';
import { companyDeletionRequestedEmail } from './templates/companyDeletionRequested';
import { companyDeletionReminderEmail } from './templates/companyDeletionReminder';
import { companyDeletionCancelledEmail } from './templates/companyDeletionCancelled';
import { companyDeletedEmail } from './templates/companyDeleted';

/**
 * Renders a queued `mail/{id}` doc into subject/html/text using its
 * `template` field to pick the template. Exported (not just used internally)
 * so unit tests can hit "unknown template" without going through a Firestore
 * doc.
 */
export function renderMail(mail: FirebaseFirestore.DocumentData): RenderedEmail {
  switch (mail['template']) {
    case 'invitation':
      return invitationEmail(mail['data']);
    case 'verifyEmail':
      return verifyEmailEmail(mail['data']);
    case 'resetPassword':
      return resetPasswordEmail(mail['data']);
    case 'changeEmail':
      return changeEmailEmail(mail['data']);
    case 'companyDeletionRequested':
      return companyDeletionRequestedEmail(mail['data']);
    case 'companyDeletionReminder':
      return companyDeletionReminderEmail(mail['data']);
    case 'companyDeletionCancelled':
      return companyDeletionCancelledEmail(mail['data']);
    case 'companyDeleted':
      return companyDeletedEmail(mail['data']);
    case undefined:
    case null:
    case '': {
      // Raw mail: caller supplied subject/html/text directly.
      if (typeof mail['subject'] === 'string' && typeof mail['html'] === 'string') {
        return { subject: mail['subject'], html: mail['html'], text: mail['text'] ?? '' };
      }
      throw new Error('Raw mail requires subject and html fields');
    }
    default:
      throw new Error(`Unknown mail template: ${String(mail['template'])}`);
  }
}

/**
 * Delivers one `mail/{id}` doc: renders it, sends it via Resend, and records
 * the outcome on the same doc. Shared by both the `onMailQueued` trigger
 * (fresh docs, status `queued`) and `runMailRetrySweep` (previously-failed
 * docs, status `retry`) — this is the ONE place that talks to Resend and
 * writes a delivery outcome, so the two callers can never drift apart on
 * what counts as success, a transient failure, or a permanent one.
 *
 * Doc shape:
 *   { to, status: 'queued'|'retry', template, data, companyId?, priority? }
 *   { to, status: 'queued'|'retry', subject, html, text }   // raw mail
 * After send:
 *   status → 'sent' (+ sentAt, providerId)
 *          | 'retry' (+ attempts, lastError, nextAttemptAt)  — transient, budget left
 *          | 'error' (+ error, failedAt, attempts)           — permanent, or budget exhausted
 *
 * A mail doc with `priority: 'critical'` that reaches `error` (its retry
 * budget burned, or a permanent failure with none to burn) is logged with
 * the `critical_mail_delivery_failed` action string so it's greppable apart
 * from routine failures — `companyDeleted` is the only mail in this PR
 * marked critical: for a member whose account was deleted along with the
 * company, it's the last message she will ever get from Allocate.
 */
export async function deliverMail(
  snap: QueryDocumentSnapshot | DocumentSnapshot,
  apiKey: string,
): Promise<void> {
  const mail = snap.data();
  if (!mail) return;
  const mailId = snap.id;

  // Idempotency: only act on docs actually waiting to be sent. Guards against
  // re-delivery (Cloud Functions' own infra-level retry of this invocation)
  // and against our own status update re-triggering the create trigger.
  if (mail['status'] !== 'queued' && mail['status'] !== 'retry') {
    logger.info('deliverMail: skipping doc not in a sendable state', { mailId, status: mail['status'] });
    return;
  }

  const to: unknown = mail['to'];
  if (typeof to !== 'string' || to.length === 0) {
    await snap.ref.update({ status: 'error', error: 'Missing recipient', failedAt: Timestamp.now() });
    logger.error('deliverMail: missing recipient', { mailId });
    return;
  }

  try {
    const rendered = renderMail(mail);
    const providerId = await sendEmail(apiKey, { to, ...rendered });
    await snap.ref.update({ status: 'sent', sentAt: Timestamp.now(), providerId });
    logger.info('deliverMail: sent', { mailId, template: mail['template'] ?? 'raw', providerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = classifyMailError(err);
    const attempts = ((mail['attempts'] as number | undefined) ?? 0) + 1;
    const isCritical = mail['priority'] === 'critical';

    if (errorClass === 'transient' && attempts < MAX_MAIL_ATTEMPTS) {
      const nextAttemptAt = Timestamp.fromMillis(Date.now() + computeBackoffMs(attempts));
      await snap.ref.update({ status: 'retry', attempts, lastError: message, nextAttemptAt });
      logger.warn('deliverMail: transient failure, scheduled retry', {
        mailId,
        template: mail['template'] ?? 'raw',
        attempts,
        error: message,
      });
      return;
    }

    // Permanent failure, or a transient one that burned its whole budget.
    await snap.ref.update({ status: 'error', error: message, attempts, failedAt: Timestamp.now() });

    if (isCritical) {
      logger.error('deliverMail: critical mail exhausted retries', {
        mailId,
        template: mail['template'] ?? 'raw',
        to: mail['to'],
        companyId: mail['companyId'],
        attempts,
        error: message,
        action: 'critical_mail_delivery_failed',
      });
    } else {
      logger.error('deliverMail: send failed', { mailId, template: mail['template'] ?? 'raw', attempts, error: message });
    }
  }
}

/**
 * Retry sweep: picks up every `mail/{id}` doc with `status == 'retry'` whose
 * `nextAttemptAt` has passed, and redelivers it through the same
 * `deliverMail` the create trigger uses.
 *
 * Query relies on the composite index on `mail` (`status` + `nextAttemptAt`)
 * declared in `firestore.indexes.json` on another branch and already
 * deployed to alpha. NOT re-declared here — see PR D's notes in the plan.
 *
 * Exported as a plain function of `(db, apiKey)` — no `onSchedule` closure —
 * so PR E's emulator tests can call it directly against a seeded Firestore
 * without going through the Cloud Functions scheduler.
 */
export async function runMailRetrySweep(db: Firestore, apiKey: string): Promise<{ processed: number }> {
  const now = Timestamp.now();
  const snapshot = await db.collection('mail').where('status', '==', 'retry').where('nextAttemptAt', '<=', now).get();

  for (const doc of snapshot.docs) {
    await deliverMail(doc, apiKey);
  }

  logger.info('runMailRetrySweep: sweep complete', { processed: snapshot.size });
  return { processed: snapshot.size };
}
