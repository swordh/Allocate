import 'server-only'

import { initializeApp, getApps, cert, App } from 'firebase-admin/app'
import { getAuth, Auth } from 'firebase-admin/auth'
import { getFirestore, Firestore } from 'firebase-admin/firestore'

function getAdminApp(): App {
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

// Lazy proxies so importing this module never triggers initialization.
// The service account env var is RUNTIME-only; eager init would throw during
// Next.js build's "Collecting page data" phase.
function lazy<T extends object>(factory: () => T): T {
  let instance: T | undefined
  const resolve = (): T => {
    if (!instance) instance = factory()
    return instance
  }
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const target = resolve()
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export const adminAuth: Auth = lazy(() => getAuth(getAdminApp()))
export const adminDb: Firestore = lazy(() => getFirestore(getAdminApp()))
