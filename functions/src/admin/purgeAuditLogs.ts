import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';

// GDPR Art. 5(1)(e) storage limitation: purge deletion audit log entries older
// than 12 months. The log stores only a sha256 hash of the uid — no PII — but
// retention beyond the audit period has no legal basis.
export const purgeOldAuditLogs = onSchedule(
  { schedule: 'every monday 03:00', region: 'europe-west1' },
  async () => {
    const db = getFirestore();
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const old = await db.collection('deletionAuditLog')
      .where('deletedAt', '<', cutoff)
      .get();
    if (old.empty) return;
    const batch = db.batch();
    old.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }
);
