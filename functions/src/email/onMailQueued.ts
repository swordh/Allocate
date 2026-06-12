import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { Timestamp } from 'firebase-admin/firestore';
import { sendEmail, RenderedEmail } from './send';
import { invitationEmail } from './templates/invitation';
import { verifyEmailEmail } from './templates/verifyEmail';
import { resetPasswordEmail } from './templates/resetPassword';
import { changeEmailEmail } from './templates/changeEmail';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

/**
 * Reusable outbound-email channel.
 *
 * Anything that needs to send mail — the inviteUser server action now, booking
 * reminders later — writes a `mail/{id}` doc; this trigger renders and sends it
 * via Resend, then records the outcome on the same doc.
 *
 * Doc shape:
 *   { to, status: 'queued', template, data }          // templated mail
 *   { to, status: 'queued', subject, html, text }     // raw mail (no template)
 * After send: status → 'sent' (+ sentAt, providerId) | 'error' (+ error, failedAt)
 */
export const onMailQueued = onDocumentCreated(
  { document: 'mail/{mailId}', region: 'europe-west1', secrets: [RESEND_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const mail = snap.data();
    const mailId = event.params.mailId;

    // Idempotency: only act on freshly-queued docs. Guards against re-delivery
    // and against our own status update re-triggering the function.
    if (mail['status'] !== 'queued') {
      logger.info('onMailQueued: skipping non-queued doc', { mailId, status: mail['status'] });
      return;
    }

    const to: unknown = mail['to'];
    if (typeof to !== 'string' || to.length === 0) {
      await snap.ref.update({ status: 'error', error: 'Missing recipient', failedAt: Timestamp.now() });
      logger.error('onMailQueued: missing recipient', { mailId });
      return;
    }

    try {
      const rendered = renderMail(mail);
      const providerId = await sendEmail(RESEND_API_KEY.value(), { to, ...rendered });
      await snap.ref.update({ status: 'sent', sentAt: Timestamp.now(), providerId });
      logger.info('onMailQueued: sent', { mailId, template: mail['template'] ?? 'raw', providerId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await snap.ref.update({ status: 'error', error: message, failedAt: Timestamp.now() });
      logger.error('onMailQueued: send failed', { mailId, error: message });
    }
  },
);

function renderMail(mail: FirebaseFirestore.DocumentData): RenderedEmail {
  switch (mail['template']) {
    case 'invitation':
      return invitationEmail(mail['data']);
    case 'verifyEmail':
      return verifyEmailEmail(mail['data']);
    case 'resetPassword':
      return resetPasswordEmail(mail['data']);
    case 'changeEmail':
      return changeEmailEmail(mail['data']);
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
