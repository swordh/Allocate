import { logger } from 'firebase-functions/v2';
import { getFunctions } from 'firebase-admin/functions';
import type { Firestore } from 'firebase-admin/firestore';
import {
  planBookingEnqueue,
  planCompanyEnqueue,
  transitionFor,
  watchedFieldsChanged,
  readAutoPrefs,
  scheduleTimeFor,
  taskId,
  type AutoBookingFields,
  type AutoTaskPayload,
  type AutoTransition,
} from './autoStatusLogic';

/**
 * Enqueue side of automatic check-out / check-in (issue #329): what the two
 * Firestore triggers in `autoStatusTriggers.ts` do, as plain functions with
 * the Firestore handle and the queue injected — callable from a Vitest run
 * with a fake of each, no trigger invocation and no Cloud Tasks needed.
 */

/** Queue function resource name — `<region>/functions/<export name of the task handler>`. */
export const AUTO_STATUS_QUEUE = 'locations/europe-west1/functions/bookingAutoStatusTask';

export interface AutoStatusTask {
  /** Cloud Tasks task id; enqueueing an id that was used recently is a 409. */
  id: string;
  payload: AutoTaskPayload;
  /** Epoch ms; undefined means "dispatch now". */
  scheduleTime?: number;
}

export type EnqueueFn = (task: AutoStatusTask) => Promise<void>;

/** The production `EnqueueFn`, backed by the Admin SDK's task queue. */
export function createTaskEnqueuer(): EnqueueFn {
  const queue = getFunctions().taskQueue(AUTO_STATUS_QUEUE);
  return (task) =>
    queue.enqueue(task.payload, {
      id: task.id,
      scheduleTime: task.scheduleTime === undefined ? undefined : new Date(task.scheduleTime),
    });
}

/**
 * Enqueues `task`, treating "a task with this id already exists" as success.
 * Eventarc delivers at least once and the triggers have `retry: true`, so the
 * same event can run twice — the second enqueue carries the same id and gets
 * `functions/task-already-exists`, which means the first one stuck. Anything
 * else is a real failure and is rethrown so the trigger retries.
 */
export async function safeEnqueue(enqueue: EnqueueFn, task: AutoStatusTask): Promise<void> {
  try {
    await enqueue(task);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.endsWith('task-already-exists')) {
      logger.info('autoStatusEnqueue: task already exists', { taskId: task.id });
      return;
    }
    throw err;
  }
}

export interface EnqueueDeps {
  db: Firestore;
  enqueue: EnqueueFn;
  now: () => number;
}

/**
 * The id carries the CloudEvent id on purpose. Cloud Tasks blocks a used id
 * for about an hour, so an id built only from booking + due time would
 * silently drop a legitimate second transition (book → cancel → re-confirm to
 * the same slot inside the hour). With `eventId` in it, every real change gets
 * a fresh id while a redelivery of the SAME event reproduces the same one —
 * which is exactly what `safeEnqueue`'s 409 handling relies on.
 */
function buildTask(
  eventId: string,
  companyId: string,
  bookingId: string,
  transition: AutoTransition,
  dueAt: number,
  now: number,
): AutoStatusTask {
  return {
    id: taskId(transition, [companyId, bookingId, transition, dueAt, eventId]),
    payload: { companyId, bookingId, transition, dueAt },
    scheduleTime: scheduleTimeFor(dueAt, now),
  };
}

/**
 * A booking document was created, changed or deleted. Enqueues the check-out
 * (status `confirmed`) or check-in (status `checked_out`) task if the
 * company's flag for it is on and a relevant field changed.
 *
 * Loop check: the handler's own `confirmed → checked_out` write re-enters
 * here and enqueues the check-in; its `checked_out → returned` write has no
 * transition, so it ends there.
 */
export async function runBookingWritten(
  deps: EnqueueDeps,
  args: {
    eventId: string;
    companyId: string;
    bookingId: string;
    before?: AutoBookingFields;
    after?: AutoBookingFields;
  },
): Promise<void> {
  const { eventId, companyId, bookingId, before, after } = args;
  // Cheap exits before the company read: most booking writes are deletes, are
  // to statuses that never transition (pending, returned, cancelled), or touch
  // only fields that don't move this transition's due time.
  if (!after) return;
  const transition = transitionFor(after.status);
  if (!transition || !watchedFieldsChanged(before, after, transition)) return;

  const companySnap = await deps.db.collection('companies').doc(companyId).get();
  const plan = planBookingEnqueue(before, after, readAutoPrefs(companySnap.data()));
  if (!plan) return;

  await safeEnqueue(deps.enqueue, buildTask(eventId, companyId, bookingId, plan.transition, plan.dueAt, deps.now()));
  logger.info('autoStatusEnqueue: booking task enqueued', { companyId, bookingId, transition: plan.transition });
}

/** At most this many enqueues in flight at once while fanning out a company. */
const ENQUEUE_CONCURRENCY = 25;

/**
 * A company document was updated. If an auto flag just went on, or it is on
 * and the time zone changed, enqueue a task for every booking in that company
 * that is in the matching status and whose due time is not before the flag's
 * `since`. Only that company's bookings are read (single-field equality, so no
 * composite index).
 *
 * Returns early (no bookings read) when nothing relevant changed — the `stats`
 * mirror also writes to the company document, and each of those writes fires
 * this trigger.
 */
export async function runCompanyUpdated(
  deps: EnqueueDeps,
  args: {
    eventId: string;
    companyId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  const { eventId, companyId, before, after } = args;
  if (!before || !after) return;

  // The early return: `planCompanyEnqueue` only reports a transition when an
  // auto flag flipped on or the zone changed, so a write that leaves
  // `preferences` alone (the `stats` mirror) yields [] and reads no bookings.
  const afterPrefs = readAutoPrefs(after);
  const transitions = planCompanyEnqueue(readAutoPrefs(before), afterPrefs);
  if (transitions.length === 0) return;

  const now = deps.now();
  for (const transition of transitions) {
    const status = transition === 'checkout' ? 'confirmed' : 'checked_out';
    const snap = await deps.db
      .collection('companies')
      .doc(companyId)
      .collection('bookings')
      .where('status', '==', status)
      .get();

    const tasks: AutoStatusTask[] = [];
    for (const doc of snap.docs) {
      // planBookingEnqueue with no `before` applies the flag and forward-only
      // (`since`) checks; the status filter above already picked the transition.
      const plan = planBookingEnqueue(undefined, doc.data() as AutoBookingFields, afterPrefs);
      if (plan && plan.transition === transition) {
        tasks.push(buildTask(eventId, companyId, doc.id, transition, plan.dueAt, now));
      }
    }

    for (let i = 0; i < tasks.length; i += ENQUEUE_CONCURRENCY) {
      await Promise.all(tasks.slice(i, i + ENQUEUE_CONCURRENCY).map((t) => safeEnqueue(deps.enqueue, t)));
    }
    logger.info('autoStatusEnqueue: company tasks enqueued', { companyId, transition, count: tasks.length });
  }
}
