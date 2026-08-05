'use server'

import 'server-only'

import { adminDb } from '@/lib/firebase-admin'
import { parseInviteToken, isInviteExpired } from '@/lib/invite-token'
import type { InvitationRole, InvitationMirror, Invitation } from '@/types/invitation'

export type InviteValidation =
  | {
      ok: true
      token: string
      companyName: string
      role: InvitationRole
      email: string
      expiresAt: string | null
      daysLeft: number | null
    }
  | { ok: false; reason: 'malformed' | 'not_found' | 'accepted' | 'revoked' | 'expired' }

const MS_PER_DAY = 24 * 60 * 60 * 1000

function daysLeftFrom(expiresAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / MS_PER_DAY))
}

/**
 * Validates an invite token — deliberately public and session-less. The
 * 128-bit token IS the bearer credential, the same trust model
 * firestore.rules already grants at `invitations/{token}` (single-doc get,
 * no list, no write). Do not add a session guard here.
 *
 * `input` may be a full invite URL (`/invite/<token>` or `?token=<token>`)
 * or a bare token — see `lib/invite-token.ts` for the shared parser.
 *
 * `not_found` is returned for BOTH a missing mirror doc and a missing
 * private doc. The two cases are never distinguished, so the response can't
 * be used to probe which half of the data is missing.
 */
export async function validateInviteToken(input: string): Promise<InviteValidation> {
  const token = parseInviteToken(input)
  if (!token) return { ok: false, reason: 'malformed' }

  const mirrorSnap = await adminDb.collection('invitations').doc(token).get()
  if (!mirrorSnap.exists) return { ok: false, reason: 'not_found' }

  const mirror = mirrorSnap.data() as InvitationMirror

  const inviteSnap = await adminDb
    .doc(`companies/${mirror.companyId}/invitations/${mirror.inviteId}`)
    .get()
  if (!inviteSnap.exists) return { ok: false, reason: 'not_found' }

  const invite = inviteSnap.data() as Invitation

  if (invite.status === 'accepted') return { ok: false, reason: 'accepted' }
  if (invite.status === 'revoked') return { ok: false, reason: 'revoked' }

  if (isInviteExpired(invite.expiresAt)) return { ok: false, reason: 'expired' }

  const companySnap = await adminDb.doc(`companies/${mirror.companyId}`).get()
  const companyName = (companySnap.data()?.name as string) || 'this company'

  return {
    ok: true,
    token,
    companyName,
    role: invite.role,
    email: invite.email,
    expiresAt: invite.expiresAt ?? null,
    daysLeft: invite.expiresAt ? daysLeftFrom(invite.expiresAt) : null,
  }
}
