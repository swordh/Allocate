import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';

// Set the deployment region for all Cloud Functions in this codebase.
// Must be called before any function module is imported.
setGlobalOptions({ region: 'europe-west1' });

// Initialize the Admin SDK once at module load. All function modules
// import from 'firebase-admin/auth' and 'firebase-admin/firestore' directly;
// they rely on this default app being initialized first.
initializeApp();

// ── Auth ──────────────────────────────────────────────────────────────────────
// createCompany  → superseded by actions/auth.ts#setupNewCompany  (#21)
// setActiveClaim → superseded by actions/auth.ts#switchCompany     (#21)
export { deleteAccount } from './auth/deleteAccount';

// ── Equipment ─────────────────────────────────────────────────────────────────
// addEquipment       → superseded by actions/equipment.ts#createEquipment    (#21)
// updateEquipment    → superseded by actions/equipment.ts#updateEquipment    (#21)
// deactivateEquipment→ superseded by actions/equipment.ts#deactivateEquipment(#21)
// addCategory        → superseded by actions/equipment.ts (category actions) (#21)

// ── Bookings ──────────────────────────────────────────────────────────────────
// checkBookingConflict → superseded by actions/bookings.ts#checkConflict     (#21, #22)
// createBooking        → superseded by actions/bookings.ts#createBooking     (#21)
// updateBooking        → superseded by actions/bookings.ts#updateBooking     (#21)
// cancelBooking        → superseded by actions/bookings.ts#cancelBooking     (#21)
// approveBooking       → superseded by actions/bookings.ts#approveBooking    (#21)
// rejectBooking        → superseded by actions/bookings.ts#approveBooking    (#21)
export { updateBookingStatus } from './bookings/updateBookingStatus';
