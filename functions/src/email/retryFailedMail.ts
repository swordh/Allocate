import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { runMailRetrySweep } from './mailDelivery';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

/**
 * Thin `onSchedule` wrapper around `runMailRetrySweep`. The mail queue used
 * to swallow every send failure into `status:'error'` with no way back —
 * this is the fix: anything `deliverMail` classified as transient (network
 * blip, Resend rate limit or 5xx) gets `status:'retry'` with a backoff
 * timestamp, and this sweep is what actually redelivers it.
 *
 * All logic lives in `runMailRetrySweep(db, apiKey)` — kept out of this
 * closure on purpose, unlike `autoBookingStatusUpdate`, so it's callable
 * directly from an emulator test without a scheduler invocation.
 */
export const retryFailedMail = onSchedule(
  { schedule: 'every 10 minutes', region: 'europe-west1', secrets: [RESEND_API_KEY] },
  async () => {
    const result = await runMailRetrySweep(getFirestore(), RESEND_API_KEY.value());
    logger.info('retryFailedMail: sweep complete', result);
  },
);
