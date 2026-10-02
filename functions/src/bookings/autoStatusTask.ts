import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  decideTask,
  readAutoPrefs,
  scheduleTimeFor,
  taskId,
  type AutoBookingFields,
  type AutoTaskPayload,
} from './autoStatusLogic';
import { createTaskEnqueuer, safeEnqueue, type EnqueueFn } from './autoStatusEnqueue';

/**
 * The Cloud Tasks handler for automatic check-out / check-in (issue #329).
 * One task per booking and transition, enqueued by `autoStatusTriggers.ts` for
 * the exact company-local wall-clock time.
 *
 * Nothing in the payload is trusted beyond its ids: the booking and the
 * company are re-read inside a transaction and `decideTask` decides from what
 * is there NOW — so a cancelled, rescheduled, manually checked-out or
 * flag-disabled booking is a no-op, and a duplicate or late task can't apply a
 * transition twice (the second sees the new status and skips).
 *
 * Private function: no `invoker`, so only a service account with
 * `roles/run.invoker` (the Cloud Tasks OIDC token) can call it.
 *
 * No conflict detection on apply. A pending/confirmed booking can be edited at
 * any time (updateBooking), but rescheduling it re-fires the booking trigger,
 * which enqueues a fresh task for the new due time and makes this one stale
 * (`decideTask` → `stale`); a manual check-out/cancel makes it skip on status.
 */

/** Keep in step with `retryConfig.maxAttempts` below — the final-attempt check relies on it. */
export const MAX_ATTEMPTS = 8;

export interface TaskDeps {
  db: Firestore;
  enqueue: EnqueueFn;
  now: () => number;
}

function parsePayload(raw: unknown): AutoTaskPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !v.includes('/');
  if (!id(p.companyId) || !id(p.bookingId)) return null;
  if (p.transition !== 'checkout' && p.transition !== 'checkin') return null;
  if (typeof p.dueAt !== 'number' || !Number.isFinite(p.dueAt)) return null;
  return {
    companyId: p.companyId as string,
    bookingId: p.bookingId as string,
    transition: p.transition,
    dueAt: p.dueAt,
  };
}

/**
 * Handles one dispatched task. `parentTaskId` is Cloud Tasks' own id for it,
 * used to derive the id of a follow-up hop. A malformed payload is logged and
 * dropped (returning normally) — retrying could never make it valid; any other
 * failure throws so Cloud Tasks retries per the queue's `retryConfig`.
 */
export async function runAutoStatusTask(
  deps: TaskDeps,
  rawPayload: unknown,
  parentTaskId: string,
  isFinalAttempt = false,
): Promise<void> {
  const payload = parsePayload(rawPayload);
  if (!payload) {
    logger.error('bookingAutoStatusTask: invalid payload, dropping', { parentTaskId });
    return;
  }
  try {
    await processTask(deps, payload, parentTaskId);
  } catch (err) {
    if (isFinalAttempt) {
      // Cloud Tasks drops the task after this and nothing else will pick the
      // booking up — leave a stable, greppable marker. One structured entry
      // (not console.error of an object, which Cloud Logging splits per line);
      // ids only, no PII.
      logger.error('AUTO_STATUS_TASK_FAILED', {
        marker: 'AUTO_STATUS_TASK_FAILED',
        companyId: payload.companyId,
        bookingId: payload.bookingId,
        transition: payload.transition,
      });
    }
    throw err;
  }
}

async function processTask(deps: TaskDeps, payload: AutoTaskPayload, parentTaskId: string): Promise<void> {
  const { companyId, bookingId, transition, dueAt } = payload;
  const companyRef = deps.db.collection('companies').doc(companyId);
  const bookingRef = companyRef.collection('bookings').doc(bookingId);

  const kind = await deps.db.runTransaction(async (tx) => {
    const [bookingSnap, companySnap] = await Promise.all([tx.get(bookingRef), tx.get(companyRef)]);
    const decision = decideTask(
      payload,
      bookingSnap.exists ? (bookingSnap.data() as AutoBookingFields) : undefined,
      readAutoPrefs(companySnap.data()),
      deps.now(),
    );
    if (decision.kind === 'apply') {
      tx.update(
        bookingRef,
        transition === 'checkout'
          ? {
              status: 'checked_out',
              checkedOutAt: FieldValue.serverTimestamp(),
              checkOutSource: 'auto',
              updatedAt: FieldValue.serverTimestamp(),
            }
          : {
              status: 'returned',
              returnedAt: FieldValue.serverTimestamp(),
              returnSource: 'auto',
              updatedAt: FieldValue.serverTimestamp(),
            },
      );
    }
    return decision.kind === 'skip' ? `skip:${decision.reason}` : decision.kind;
  });

  if (kind === 'hop') {
    // Due is further out than Cloud Tasks can schedule: the task was capped at
    // 29 days. Enqueue the next leg, outside the transaction (a side effect
    // must not run inside a retryable transaction body).
    const now = deps.now();
    await safeEnqueue(deps.enqueue, {
      // Derived from the parent id ONLY — never the clock — so a redelivery of
      // the same parent (attempt N after a failed enqueue) reproduces the same
      // child id and hits task-already-exists instead of forking a second chain.
      id: taskId(transition, [parentTaskId, 'hop']),
      payload,
      scheduleTime: scheduleTimeFor(dueAt, now),
    });
  }

  logger.info('bookingAutoStatusTask', { companyId, bookingId, transition, outcome: kind });
}

export const bookingAutoStatusTask = onTaskDispatched(
  {
    region: 'europe-west1',
    retryConfig: { maxAttempts: MAX_ATTEMPTS, minBackoffSeconds: 30, maxBackoffSeconds: 3600, maxDoublings: 5 },
    rateLimits: { maxConcurrentDispatches: 20, maxDispatchesPerSecond: 10 },
    timeoutSeconds: 60,
  },
  async (request) => {
    await runAutoStatusTask(
      { db: getFirestore(), enqueue: createTaskEnqueuer(), now: () => Date.now() },
      request.data,
      request.id,
      // retryCount is 0 on the first attempt, so attempt N has retryCount N-1.
      request.retryCount >= MAX_ATTEMPTS - 1,
    );
  },
);
