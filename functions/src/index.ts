import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';

// Set the deployment region for all Cloud Functions in this codebase.
// Must be called before any function module is imported.
setGlobalOptions({ region: 'europe-west1' });

// Initialize the Admin SDK once at module load. All function modules
// import from 'firebase-admin/auth' and 'firebase-admin/firestore' directly;
// they rely on this default app being initialized first.
initializeApp();

export { acceptInvitationByToken } from './auth/acceptInvitation';
export { onUserCreate } from './auth/onUserCreate';
export { purgeOldAuditLogs } from './admin/purgeAuditLogs';
export { autoBookingStatusUpdate } from './bookings/autoStatusUpdate';
export { onMailQueued } from './email/onMailQueued';
