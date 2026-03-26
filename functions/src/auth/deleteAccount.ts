import { onCall, HttpsError } from 'firebase-functions/v2/https';

/**
 * deleteAccount — GDPR Art. 17 Right to Erasure
 *
 * Permanently deletes the calling user's account and anonymizes their booking
 * records across all companies they belonged to.
 *
 * ─── PHASE 5 TODO ────────────────────────────────────────────────────────────
 *
 * This function is a documented stub. Full implementation is required before
 * any user can create an account (see plan/02-gdpr-compliance.md, Phase 1).
 *
 * Implementation checklist (must follow this exact order):
 *
 * 1. SOLE-ADMIN CHECK (block, never cascade)
 *    - Query collectionGroup('memberships') where companyId == X and role == 'admin'
 *      for every company the user is an admin of.
 *    - If the user is the sole admin of any company, throw:
 *        'failed-precondition' — "You are the only admin of [Company Name].
 *        Transfer the admin role or delete the company before deleting your account."
 *    - Never silently delete the company. That is a separate, explicit action.
 *    - This requires the `companyId` field to be present on membership documents
 *      (it is — see MembershipDocument in types.ts).
 *    - Requires a Firestore collectionGroup index on memberships.companyId.
 *      Deploy the index before testing; missing indexes cause silent failures.
 *
 * 2. ANONYMIZE BOOKINGS (do not delete — company retains operational records)
 *    - collectionGroup query: bookings where userId == uid across all companies.
 *      NOTE: This requires a Firestore collectionGroup index on bookings.userId.
 *    - For each matching booking document, set:
 *        userId: null
 *        userName: null  (already null for new bookings; set explicitly for legacy records)
 *    - Use batched writes. Each Firestore batch supports up to 500 operations.
 *      For users with more than ~490 matching booking documents, commit the current
 *      batch and start a new one (use a counter).
 *
 * 3. DELETE USER DOCUMENTS (batched write)
 *    - Delete /users/{uid}
 *    - Delete all /users/{uid}/memberships/{companyId} documents
 *    - Commit as a single batch (or sequential batches if > 500 documents).
 *
 * 4. WRITE DELETION AUDIT LOG (no PII)
 *    - Write to /deletionAuditLog/{logId}:
 *        userIdHash:   SHA-256 of uid (hex string) — never log the uid itself
 *        deletedAt:    FieldValue.serverTimestamp()
 *        triggeredBy:  "user_self"
 *    - See plan/02-gdpr-compliance.md for the full DeletionAuditLog schema.
 *
 * 5. DELETE FIREBASE AUTH RECORD (must be last)
 *    - getAuth().deleteUser(uid)
 *    - This step is irreversible. Once done, the user cannot retry if a
 *      previous step failed. Ensure all Firestore writes are committed and
 *      the audit log is written before this call.
 *    - Custom Claims are automatically removed when the Auth record is deleted.
 *
 * ─── DATA EXPORT NOTE (Phase 5) ──────────────────────────────────────────────
 *
 * The exportUserData Cloud Function (Art. 15/20) must include bookings in its
 * response. Booking fields to export per record:
 *   companyId, bookingId, projectName, startDate, endDate,
 *   status, createdAt, items (equipmentIds + quantities)
 *
 * Do NOT include other users' data or company financial data in the export.
 *
 * ─── FIRESTORE INDEXES REQUIRED ──────────────────────────────────────────────
 *
 * Before this function can be deployed and tested, two collectionGroup indexes
 * must be created in Firestore:
 *   1. Collection group: memberships — field: companyId (ascending)
 *      (also needs role field for the sole-admin filter)
 *   2. Collection group: bookings — field: userId (ascending)
 *
 * Add these to firestore.indexes.json and deploy with `firebase deploy --only firestore`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const deleteAccount = onCall({ region: 'europe-west1', cors: true, invoker: 'public' }, async (_request) => {
  // Phase 5: implement the steps documented above.
  throw new HttpsError(
    'unimplemented',
    'Account deletion is not yet available. Please contact support to request account deletion.',
  );
});
