import type { Timestamp } from 'firebase-admin/firestore';

/** e.g. "12 September 2026" — matches the example dates in the mail template docblocks. */
export function formatDateFull(ts: Timestamp): string {
  return ts.toDate().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** e.g. "19 Sep" — for the mail hero/eyebrow, per CompanyDeletionRequestedData's `scheduledForShort`. */
export function formatDateShort(ts: Timestamp): string {
  return ts.toDate().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function buildCancelUrl(token: string): string {
  return `https://allocate.at/company-deletion/cancel/${token}`;
}
