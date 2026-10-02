import { onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { createTaskEnqueuer, runBookingWritten, runCompanyUpdated } from './autoStatusEnqueue';

/**
 * Firestore triggers that feed the automatic check-out / check-in task queue
 * (issue #329) — wiring only; the logic is in `autoStatusEnqueue.ts` and the
 * handler in `autoStatusTask.ts`.
 *
 * Same style as `onMailQueued`: explicit `region`, no `database` option. At
 * least once delivery with `retry: true`, so a failed enqueue is retried by
 * Eventarc; duplicates are harmless because the task id includes the CloudEvent
 * id (see `buildTask`).
 *
 * The job-heartbeat watchdog (`checkJobHeartbeats`, #430) does not apply here:
 * it guards SCHEDULED jobs that can go quietly missing. These are event-driven
 * — there is no schedule to miss, and a failure shows up as a retried
 * invocation, not as silence.
 */

export const onBookingWrittenAutoStatus = onDocumentWritten(
  { document: 'companies/{companyId}/bookings/{bookingId}', region: 'europe-west1', retry: true },
  async (event) => {
    await runBookingWritten(
      { db: getFirestore(), enqueue: createTaskEnqueuer(), now: () => Date.now() },
      {
        eventId: event.id,
        companyId: event.params.companyId,
        bookingId: event.params.bookingId,
        before: event.data?.before?.data(),
        after: event.data?.after?.data(),
      },
    );
  },
);

/**
 * `timeoutSeconds: 300` — a flag flip fans out over every open booking in the
 * company; a very large company could in principle outgrow this and would need
 * the loop paginated.
 */
export const onCompanyAutoStatusChanged = onDocumentUpdated(
  { document: 'companies/{companyId}', region: 'europe-west1', retry: true, timeoutSeconds: 300 },
  async (event) => {
    await runCompanyUpdated(
      { db: getFirestore(), enqueue: createTaskEnqueuer(), now: () => Date.now() },
      {
        eventId: event.id,
        companyId: event.params.companyId,
        before: event.data?.before.data(),
        after: event.data?.after.data(),
      },
    );
  },
);
