import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function getLocalNow(tz: string): { todayStr: string; timeStr: string } {
  const now = new Date()
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: tz })
  const timeStr = now.toLocaleTimeString('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).slice(0, 5)
  return { todayStr, timeStr }
}

export const autoBookingStatusUpdate = onSchedule(
  { schedule: 'every 5 minutes', region: 'europe-west1' },
  async () => {
    const db = getFirestore();

    const prefsCache = new Map<string, Record<string, unknown>>();
    async function getPrefs(companyId: string) {
      if (prefsCache.has(companyId)) return prefsCache.get(companyId)!;
      const snap = await db.collection('companies').doc(companyId).get();
      const prefs = (snap.data()?.preferences ?? {}) as Record<string, unknown>;
      prefsCache.set(companyId, prefs);
      return prefs;
    }

    // ── Auto Checkout: confirmed → checked_out at startDate/startTime ──────────
    const confirmedSnap = await db
      .collectionGroup('bookings')
      .where('status', '==', 'confirmed')
      .get();

    const checkoutUpdates: Promise<unknown>[] = [];

    for (const doc of confirmedSnap.docs) {
      const data = doc.data();
      const startDate = data.startDate as string;
      const startTime = (data.startTime as string | null) ?? null;

      const companyId = doc.ref.parent.parent?.id;
      if (!companyId) continue;

      const prefs = await getPrefs(companyId);
      if (!prefs.autoCheckout) continue;

      const tz = typeof prefs.timezone === 'string' ? prefs.timezone : 'UTC';
      const { todayStr, timeStr } = getLocalNow(tz);

      if (startDate > todayStr) continue;
      if (startDate === todayStr && startTime !== null && startTime > timeStr) continue;

      checkoutUpdates.push(
        doc.ref.update({ status: 'checked_out', updatedAt: FieldValue.serverTimestamp() })
      );
    }

    await Promise.all(checkoutUpdates);

    // ── Auto Checkin: checked_out → returned at endDate/endTime ───────────────
    const checkedOutSnap = await db
      .collectionGroup('bookings')
      .where('status', '==', 'checked_out')
      .get();

    const checkinUpdates: Promise<unknown>[] = [];

    for (const doc of checkedOutSnap.docs) {
      const data = doc.data();
      const endDate = data.endDate as string;
      const endTime = (data.endTime as string | null) ?? null;

      const companyId = doc.ref.parent.parent?.id;
      if (!companyId) continue;

      const prefs = await getPrefs(companyId);
      if (!prefs.autoCheckin) continue;

      const tz = typeof prefs.timezone === 'string' ? prefs.timezone : 'UTC';
      const { todayStr, timeStr } = getLocalNow(tz);

      if (endDate > todayStr) continue;
      if (endDate === todayStr && endTime !== null && endTime > timeStr) continue;

      checkinUpdates.push(
        doc.ref.update({ status: 'returned', updatedAt: FieldValue.serverTimestamp() })
      );
    }

    await Promise.all(checkinUpdates);

    logger.info('autoBookingStatusUpdate', {
      checkouts: checkoutUpdates.length,
      checkins: checkinUpdates.length,
    });
  }
);
