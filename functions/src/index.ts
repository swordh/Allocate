import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';

// Set the deployment region for all Cloud Functions in this codebase.
// Must be called before any function module is imported.
setGlobalOptions({ region: 'europe-west1' });

// Initialize the Admin SDK once at module load. All function modules
// import from 'firebase-admin/auth' and 'firebase-admin/firestore' directly;
// they rely on this default app being initialized first.
initializeApp();

export { createCompany } from './auth/createCompany';
export { setActiveClaim } from './auth/setActiveClaim';
export { deleteAccount } from './auth/deleteAccount';
export { addEquipment } from './equipment/addEquipment';
export { updateEquipment } from './equipment/updateEquipment';
export { deactivateEquipment } from './equipment/deactivateEquipment';
export { addCategory } from './equipment/addCategory';
export { checkBookingConflict } from './bookings/checkBookingConflict';
export { createBooking } from './bookings/createBooking';
export { updateBooking } from './bookings/updateBooking';
export { cancelBooking } from './bookings/cancelBooking';
export { approveBooking } from './bookings/approveBooking';
export { rejectBooking } from './bookings/rejectBooking';
export { updateBookingStatus } from './bookings/updateBookingStatus';
