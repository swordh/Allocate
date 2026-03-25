import 'server-only'

import { initializeApp, getApps, cert, App } from 'firebase-admin/app'
import { getAuth, Auth } from 'firebase-admin/auth'
import { getFirestore, Firestore } from 'firebase-admin/firestore'

function createAdminApp(): App {
  if (getApps().length > 0) {
    return getApps()[0]
  }

  const serviceAccountJson = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON
  if (!serviceAccountJson) {
    throw new Error('[firebase-admin] FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON is not set')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse returns any
  const serviceAccount = JSON.parse(serviceAccountJson) as Record<string, any>

  return initializeApp({
    credential: cert(serviceAccount),
  })
}

const adminApp = createAdminApp()

export const adminAuth: Auth      = getAuth(adminApp)
export const adminDb:   Firestore = getFirestore(adminApp)
