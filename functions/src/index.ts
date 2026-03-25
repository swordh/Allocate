import { initializeApp } from 'firebase-admin/app';

// Initialize the Admin SDK once at module load. All function modules
// import from 'firebase-admin/auth' and 'firebase-admin/firestore' directly;
// they rely on this default app being initialized first.
initializeApp();

export { createCompany } from './auth/createCompany';
export { setActiveClaim } from './auth/setActiveClaim';
