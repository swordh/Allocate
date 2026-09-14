import { randomBytes } from 'crypto';
import { Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import type { CompanyDeletionDocument, CompanyDeletionCancelTokenDocument } from '../types';
import { runCompanyPurge } from './purge';
import { formatDateFull, formatDateShort, buildCancelUrl } from './format';

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

/** Cancel link lives exactly as long as the window it cancels. */
async function mintCancelToken(
  db: Firestore,
  ledgerRef: FirebaseFirestore.DocumentReference,
  requestId: string,
  companyId: string,
  expiresAt: Timestamp,
): Promise<string> {
  const token = randomBytes(24).toString('hex');
  const tokenDoc: CompanyDeletionCancelTokenDocument = {
    requestId,
    companyId,
    createdAt: Timestamp.now(),
    expiresAt,
  };
  await db.collection('companyDeletionCancelTokens').doc(token).set(tokenDoc);
  await ledgerRef.update({ cancelTokenIds: [token] });
  return token;
}

/**
 * "What goes" summary for the requested-deletion mail, e.g. "23 bookings, 14
 * pieces of equipment, access for all 6 members". Best-effort: counts come
 * from `_meta/memberCounts` and the `stats` mirror where available, plus one
 * aggregate `count()` query for bookings (there is no running "current
 * bookings" counter to read instead — `stats.bookingsCreated` is lifetime,
 * never decremented, and would overstate what's actually about to go).
 */
async function buildWhatGoesSummary(db: Firestore, companyId: string): Promise<string> {
  const companyRef = db.doc(`companies/${companyId}`);
  const [companySnap, bookingsCount] = await Promise.all([
    companyRef.get(),
    db.collection(`companies/${companyId}/bookings`).count().get(),
  ]);
  const stats = companySnap.data()?.['stats'] ?? {};
  const equipmentCount = (stats['equipmentCount'] as number | undefined) ?? 0;
  const memberCount = (stats['memberCount'] as number | undefined) ?? 0;
  const bookings = bookingsCount.data().count;

  return `${bookings} booking${bookings === 1 ? '' : 's'}, ${equipmentCount} piece${equipmentCount === 1 ? '' : 's'} of equipment, access for all ${memberCount} member${memberCount === 1 ? '' : 's'}`;
}

/**
 * Queues `companyDeletionRequested` to every admin of the company (never to
 * crew — see the design brief). Only for `mode: 'window'`: an immediate
 * request has no window to describe and this template's entire body would
 * be false for it (see that template's own docblock).
 */
async function queueRequestedMail(
  db: Firestore,
  ledgerRef: FirebaseFirestore.DocumentReference,
  requestId: string,
  ledger: CompanyDeletionDocument,
): Promise<void> {
  const token = await mintCancelToken(db, ledgerRef, requestId, ledger.companyId, ledger.scheduledFor);
  const stopUrl = buildCancelUrl(token);
  const whatGoesSummary = await buildWhatGoesSummary(db, ledger.companyId);

  const adminsSnap = await db
    .collection(`companies/${ledger.companyId}/members`)
    .where('role', '==', 'admin')
    .get();

  for (const adminDoc of adminsSnap.docs) {
    const admin = adminDoc.data();
    const email = admin['email'] as string | undefined;
    if (!email) continue;
    await db.collection('mail').add({
      to: email,
      status: 'queued',
      template: 'companyDeletionRequested',
      companyId: ledger.companyId,
      data: {
        companyName: ledger.companyName,
        requestedByName: ledger.requestedByName,
        requestedAtFormatted: formatDateFull(ledger.requestedAt),
        scheduledForFormatted: formatDateFull(ledger.scheduledFor),
        scheduledForShort: formatDateShort(ledger.scheduledFor),
        stopUrl,
        whatGoesSummary,
      },
    });
  }
}

/**
 * Handles one newly-created `companyDeletions/{requestId}` ledger doc.
 * Exported as a plain function of `(db, requestId, ledger)` — the thin
 * `onCompanyDeletionCreated` trigger below just reads the event and calls
 * this — same testability shape as every other function in this PR.
 *
 * `mode: 'window'`: queues the requested-deletion mail and mints the cancel
 * token; the purge itself starts later, when the sweep's lease claims an
 * overdue request.
 *
 * `mode: 'immediate'`: starts the purge right here, synchronously. This is
 * deliberate, not a shortcut — see "Begäran och avbrytning" in the plan:
 * doing it from THIS trigger (idempotent, retried by Cloud Functions'
 * infra on its own if it fails) rather than from the Next.js server action
 * that created the ledger doc is what keeps a slow or failed HTTP response
 * from ever being the reason an entire company's purge does or doesn't
 * start.
 */
export async function handleCompanyDeletionCreated(
  db: Firestore,
  requestId: string,
  ledger: CompanyDeletionDocument,
): Promise<void> {
  const ledgerRef = db.collection('companyDeletions').doc(requestId);

  if (ledger.mode === 'window') {
    await queueRequestedMail(db, ledgerRef, requestId, ledger);
    return;
  }

  // mode === 'immediate'
  await runCompanyPurge(db, requestId);
}

export const onCompanyDeletionCreated = onDocumentCreated(
  {
    document: 'companyDeletions/{requestId}',
    region: 'europe-west1',
    secrets: [STRIPE_SECRET_KEY],
    // Sized for the `mode: 'immediate'` branch, which runs the purge
    // synchronously in this same invocation — see runCompanyPurge's own
    // docblock for why these numbers (540s / 1GiB) in particular.
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    try {
      await handleCompanyDeletionCreated(getFirestore(), snap.id, snap.data() as CompanyDeletionDocument);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('onCompanyDeletionCreated: failed', { requestId: snap.id, error: message });
      throw err; // let Cloud Functions' own infra-level retry take over
    }
  },
);
