'use server'

import 'server-only'
import type { ActionCodeSettings } from 'firebase-admin/auth'
import { adminAuth, adminDb } from '@/lib/firebase-admin'

/** Canonical error code from a FirebaseAuthError (e.g. 'auth/user-not-found'). */
function firebaseErrorCode(err: unknown): string {
  return (err as { code?: string }).code ?? 'unknown'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Resolves the public app URL used to build our own action links. Must be a
 * domain listed in Firebase Auth → Authorized domains, otherwise generateLink
 * rejects the ActionCodeSettings.
 */
function appUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL
  if (!url) throw new Error('NEXT_PUBLIC_APP_URL not set')
  return url.replace(/\/$/, '')
}

/**
 * The oobCode bridge. Firebase mints an action link pointing at its own
 * /__/auth/action handler; we keep only the one-time `oobCode` and rebuild the
 * link against our own /auth/action page so the email never exposes a Firebase
 * domain. Returns a clean allocate.at URL.
 */
function toActionUrl(firebaseLink: string, fallbackMode: string): string {
  const parsed = new URL(firebaseLink)
  const oobCode = parsed.searchParams.get('oobCode')
  const mode = parsed.searchParams.get('mode') ?? fallbackMode
  if (!oobCode) throw new Error('Firebase link missing oobCode')

  const out = new URL(`${appUrl()}/auth/action`)
  out.searchParams.set('mode', mode)
  out.searchParams.set('oobCode', oobCode)
  return out.toString()
}

/** Enqueues a mail doc for the onMailQueued Cloud Function to send via Resend. */
async function queueMail(to: string, template: string, data: Record<string, unknown>): Promise<void> {
  await adminDb.collection('mail').add({
    to,
    template,
    data,
    status: 'queued',
    createdAt: new Date().toISOString(),
  })
}

/**
 * Sends the email-verification link via Resend. The caller's identity is taken
 * from the verified ID token — never from a client-supplied email — so this
 * can't be used to spam arbitrary addresses or probe which accounts exist.
 */
export async function sendVerificationEmail(idToken: string): Promise<{ error?: string }> {
  let email: string
  try {
    const decoded = await adminAuth.verifyIdToken(idToken)
    email = decoded.email ?? ''
  } catch {
    return { error: 'Invalid session.' }
  }
  if (!email) return { error: 'No email on account.' }

  const settings: ActionCodeSettings = { url: `${appUrl()}/auth/action`, handleCodeInApp: false }

  try {
    const link = await adminAuth.generateEmailVerificationLink(email, settings)
    await queueMail(email, 'verifyEmail', { verifyUrl: toActionUrl(link, 'verifyEmail') })
    console.log('[actions/auth-email]', { action: 'verification_sent' })
    return {}
  } catch (err) {
    console.error('[actions/auth-email]', { code: firebaseErrorCode(err), action: 'verification_failed' })
    return { error: 'Could not send the verification email. Please try again.' }
  }
}

/**
 * Sends a password-reset link via Resend. Always reports success to the client
 * (swallows user-not-found) so the form can't be used to enumerate accounts.
 * `throttled` surfaces the one error state the design DOES show — Firebase's
 * own rate limiting — without revealing whether the address has an account.
 */
export async function requestPasswordReset(rawEmail: string): Promise<{ ok: true; throttled?: boolean }> {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) return { ok: true }

  const settings: ActionCodeSettings = { url: `${appUrl()}/auth/action`, handleCodeInApp: false }

  try {
    const link = await adminAuth.generatePasswordResetLink(email, settings)
    await queueMail(email, 'resetPassword', { resetUrl: toActionUrl(link, 'resetPassword') })
    console.log('[actions/auth-email]', { action: 'reset_sent' })
  } catch (err) {
    // user-not-found is expected and intentionally silent. Log anything else.
    const code = firebaseErrorCode(err)
    if (code === 'auth/too-many-requests') {
      return { ok: true, throttled: true }
    }
    if (code !== 'auth/user-not-found') {
      console.error('[actions/auth-email]', { code, action: 'reset_failed' })
    }
  }
  return { ok: true }
}

/**
 * Sends a "confirm your new email" link to the NEW address via Resend. The
 * change only takes effect once that link is clicked (applyActionCode).
 */
export async function requestEmailChange(
  idToken: string,
  rawNewEmail: string,
): Promise<{ error?: string }> {
  let currentEmail: string
  try {
    const decoded = await adminAuth.verifyIdToken(idToken)
    currentEmail = decoded.email ?? ''
  } catch {
    return { error: 'Invalid session.' }
  }
  if (!currentEmail) return { error: 'No email on account.' }

  const newEmail = typeof rawNewEmail === 'string' ? rawNewEmail.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(newEmail)) return { error: 'Enter a valid email address.' }
  if (newEmail === currentEmail.toLowerCase()) {
    return { error: 'That’s already your email address.' }
  }

  const settings: ActionCodeSettings = { url: `${appUrl()}/auth/action`, handleCodeInApp: false }

  try {
    const link = await adminAuth.generateVerifyAndChangeEmailLink(currentEmail, newEmail, settings)
    await queueMail(newEmail, 'changeEmail', {
      verifyUrl: toActionUrl(link, 'verifyAndChangeEmail'),
      newEmail,
    })
    console.log('[actions/auth-email]', { action: 'email_change_sent' })
    return {}
  } catch (err) {
    const code = firebaseErrorCode(err)
    // The address is taken by another account — tell the user without leaking more.
    if (code === 'auth/email-already-exists') {
      return { error: 'That email address is already in use.' }
    }
    console.error('[actions/auth-email]', { code, action: 'email_change_failed' })
    return { error: 'Could not send the confirmation email. Please try again.' }
  }
}
