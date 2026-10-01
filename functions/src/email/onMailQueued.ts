import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { deliverMail } from './mailDelivery';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

/**
 * Reusable outbound-email channel.
 *
 * Anything that needs to send mail — the inviteUser server action now, the
 * company-deletion lifecycle later — writes a `mail/{id}` doc; this trigger
 * fires once per created doc and hands it to `deliverMail`, the same
 * delivery code `retryFailedMail`'s sweep uses. All the rendering, sending,
 * classification and status-writing logic lives there — this file is only
 * the wiring between "a doc was created" and that function.
 */
export const onMailQueued = onDocumentCreated(
  { document: 'mail/{mailId}', region: 'europe-west1', secrets: [RESEND_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await deliverMail(snap, RESEND_API_KEY.value());
  },
);
