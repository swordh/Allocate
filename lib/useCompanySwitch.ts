'use client'

import { useCallback, useState } from 'react'
import { signInWithCustomToken } from 'firebase/auth'
import { switchCompany, createSession } from '@/actions/auth'
import { auth } from '@/lib/firebase'

export type CompanySwitchStatus = 'idle' | 'switching' | 'error'

/**
 * Exchanges a Firebase custom token for a real session: signs in with it
 * (establishing a brand new refresh token), takes the resulting ID token,
 * and re-issues the `__session` cookie via `createSession`. Does NOT
 * navigate — callers decide what "done" means (a hard reload for a company
 * switch, showing a receipt screen for issue #352's leave-company flow).
 *
 * Extracted from `useCompanySwitch` below so `leaveCompany` (actions/team.ts)
 * callers can reuse the exact same handshake: `leaveCompany` mints its own
 * custom token for the identical reason `switchCompany` does (see that
 * function's docblock) — the same `revokeRefreshTokens` call that makes
 * leaving actually secure also kills the caller's own refresh token, so
 * `getIdToken(true)` on the existing user cannot be used afterward either.
 */
export async function establishSessionFromCustomToken(customToken: string): Promise<void> {
  const credential = await signInWithCustomToken(auth, customToken)
  const freshToken = await credential.user.getIdToken()
  await createSession(freshToken)
}

/**
 * Drives `switchCompany` (actions/auth.ts) through the client-side handshake
 * its own docblock requires. `switchCompany` only updates custom claims and
 * revokes refresh tokens server-side — it never touches the `__session`
 * cookie, and (see its docblock) the caller cannot simply refresh the
 * existing user's ID token afterwards: `revokeRefreshTokens` invalidates the
 * calling browser's own refresh token along with everyone else's, so
 * `getIdToken(true)` fails at Google's STS endpoint regardless of timing.
 * `switchCompany` mints a custom token instead — `establishSessionFromCustomToken`
 * performs a real sign-in that establishes a brand new refresh token,
 * sidestepping the one just revoked.
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
      await establishSessionFromCustomToken(customToken)

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
