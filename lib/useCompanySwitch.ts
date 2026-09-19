'use client'

import { useCallback, useState } from 'react'
import { signInWithCustomToken } from 'firebase/auth'
import { switchCompany, createSession } from '@/actions/auth'
import { auth } from '@/lib/firebase'

export type CompanySwitchStatus = 'idle' | 'switching' | 'error'

/**
 * Drives `switchCompany` (actions/auth.ts) through the client-side handshake
 * its own docblock requires. `switchCompany` only updates custom claims and
 * revokes refresh tokens server-side — it never touches the `__session`
 * cookie, and (see its docblock) the caller cannot simply refresh the
 * existing user's ID token afterwards: `revokeRefreshTokens` invalidates the
 * calling browser's own refresh token along with everyone else's, so
 * `getIdToken(true)` fails at Google's STS endpoint regardless of timing.
 * `switchCompany` mints a custom token instead — `signInWithCustomToken`
 * performs a real sign-in that establishes a brand new refresh token,
 * sidestepping the one just revoked, then a normal `getIdToken()` +
 * `createSession()` re-issues the session cookie.
 */
export function useCompanySwitch() {
  const [status, setStatus] = useState<CompanySwitchStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // Returns whether the switch is proceeding to a full reload, so the caller
  // can react synchronously (e.g. reopen a menu it already closed to show
  // the inline error) instead of deriving that from `status` in an effect.
  const switchTo = useCallback(async (companyId: string): Promise<{ ok: boolean }> => {
    setStatus('switching')
    setError(null)

    try {
      const { customToken } = await switchCompany(companyId)

      const credential = await signInWithCustomToken(auth, customToken)
      const freshToken = await credential.user.getIdToken()
      await createSession(freshToken)

      window.location.href = '/'
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not switch company. Try again.'
      setError(message)
      setStatus('error')
      return { ok: false }
    }
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
  }, [])

  return { status, error, switchTo, reset }
}
