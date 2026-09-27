'use server'

import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { Timestamp, WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { memberCountsDelta, readMemberCounts } from '@/lib/companyStats'
import { listMembers } from '@/lib/queries/members'
import { mailExpireAt } from '@/lib/mail-retention'
import { ALLOWED_ROLES, toRole } from '@/lib/roles'
import { INVITE_TTL_DAYS } from '@/constants/invitation'
import { EMAIL_RE, MAX_RECIPIENTS, normalizeEmail, classifyRecipients, computeSeatsUsed } from '@/lib/invite-recipients'
import type { Role } from '@/types'
import type { Invitation, PublicInvitation } from '@/types/invitation'

const BATCH_LIMIT = 490

async function commitAndReset(batch: WriteBatch): Promise<WriteBatch> {
  await batch.commit()
  return adminDb.batch()
}

function newExpiresAt(): string {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * How long a revoked private invitation doc survives before Firestore's TTL
 * policy deletes it — issue #410. Nothing reads a revoked doc again (the
 * team page and `findPendingByEmail` both query `status == 'pending'`), so
 * this is just cleanup, not a live window.
 */
const REVOKED_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The `expireAt` Firestore TTL value for an `invitations/{token}` mirror —
 * issue #297. Set to the exact same instant as the mirror's own `expiresAt`
 * ISO string: no grace period is needed, because a resend recreates the
 * mirror (`extendPendingInvite` below does a `batch.set`, not `update`), so
 * there's nothing left to read once the token has expired.
 *
 * Stays local to this file rather than moving into `lib/invite-token.ts`,
 * which the client can reach — this is server-only.
 *
 * The TTL policy declared in `firestore.indexes.json` is scoped to the
 * `invitations` COLLECTION GROUP, not just the top-level mirror collection —
 * it also matches every `companies/{cid}/invitations/*` private doc. That's
 * intentional for an accepted/revoked private doc (issue #410 —
 * `acceptInvitationByToken` and `revokeInvitation` both stamp their own
 * `expireAt` once nothing reads the doc again), but never call THIS function
 * for a private doc, and never set `expireAt` on a PENDING private doc — a
 * live invite must survive until its own `expiresAt`, not get TTL-deleted
 * early. Also never rename this field to `expiresAt` (the private doc's own
 * field name) — either mistake would get a private invitation record
 * silently deleted (or, for a pending one, deleted while still live).
 */
function mirrorExpireAt(expiresAtIso: string): Timestamp {
  return Timestamp.fromDate(new Date(expiresAtIso))
}

/**
 * Shared resend step: pushes `expiresAt` out on the private doc and stamps
 * `lastSentAt` so the UI can show "Invite re-sent just now"
 * (`lib/invite-status.ts:inviteMeta`).
 *
 * A `runTransaction`, NOT a plain `batch` — this closes a race a security
 * review caught in the original issue #297 fix: `resendInvitation` reads
 * the private doc as a pre-check, then (previously) blindly wrote the
 * mirror as `status: 'pending'` regardless of what happened in between.
 * Interleave a concurrent `revokeInvitation` between that read and this
 * write — private doc -> 'revoked', mirror deleted — and this function
 * would recreate a LIVE pending mirror for a revoked invite, un-revoking
 * it: `acceptInvitationByToken` trusts the mirror's own `status`, so the
 * revoked link would become acceptable again (and, short of that, the
 * recreated mirror still re-exposes the invitee's email regardless of
 * whether anyone accepts it). The same shape of race applies against a
 * concurrent accept.
 *
 * The fix: re-read `inviteRef` INSIDE the transaction and re-verify
 * `status === 'pending'` there — Firestore's transaction read set makes
 * this authoritative: if a revoke or accept commits after this
 * transaction's read but before it tries to commit, this transaction is
 * retried against the now-current (non-pending) doc and returns `ok:
 * false` without writing anything. `token`/`email` also come from this
 * SAME in-transaction read, not from the caller's pre-check snapshot,
 * companyId/inviteId are still ok to take from the caller since they only
 * ADDRESS the doc rather than describe its content — closing the loop
 * entirely on stale data driving a write.
 *
 * The mirror is fully REPLACED with `tx.set`, not `tx.update` — a TTL
 * policy now deletes the mirror once its `expireAt` passes (see
 * `mirrorExpireAt`), so by the time an admin resends an invite whose mirror
 * expired a while ago, that mirror doc may no longer exist at all. `update`
 * on a missing doc throws `not-found`; `set` recreates it, which is exactly
 * what a resend of a still-pending invite should do. The mirror
 * intentionally does NOT get `lastSentAt` — it's a minimal public lookup
 * doc and nothing reads that field from it.
 *
 * Used by `resendInvitation` — the team page's per-row RESEND button. There
 * used to be a second caller (`inviteUser`'s "already-pending" fallback),
 * but that branch is gone: `inviteUsers` now skips already-invited
 * addresses instead of silently resending, so this is the only remaining
 * caller.
 */
async function extendPendingInvite(
  cid: string,
  inviteId: string,
): Promise<
  | { ok: true; expiresAt: string; lastSentAt: string; email: string; token: string }
  | { ok: false }
> {
  const expiresAt = newExpiresAt()
  const lastSentAt = new Date().toISOString()
  const inviteRef = adminDb.doc(`companies/${cid}/invitations/${inviteId}`)

  return adminDb.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef)
    if (!inviteSnap.exists) return { ok: false as const }

    const inviteData = inviteSnap.data()!
    // The authoritative check — see this function's docblock. A concurrent
    // revoke or accept that committed after `resendInvitation`'s own
    // pre-check but before this transaction's read is caught right here.
    if (inviteData.status !== 'pending') return { ok: false as const }

    const token = inviteData.token as string
    const email = inviteData.email as string
    const mirrorRef = adminDb.collection('invitations').doc(token)

    tx.update(inviteRef, { expiresAt, lastSentAt })
    tx.set(mirrorRef, {
      companyId: cid,
      inviteId,
      email,
      status: 'pending',
      expiresAt,
      expireAt: mirrorExpireAt(expiresAt),
    })

    return { ok: true as const, expiresAt, lastSentAt, email, token }
  })
}

/** Why a submitted recipient was NOT sent an invite. */
export type InviteSkipReason = 'member' | 'invited'

export interface InviteUsersResult {
  error?: string
  /** Newly created invitations — the real Firestore documents (minus `token`), one per address actually sent. */
  invitations?: PublicInvitation[]
  /** Addresses that were NOT invited, and why — already a member, or already has a pending invite. */
  skipped?: { email: string; reason: InviteSkipReason }[]
}

/**
 * Invite up to `MAX_RECIPIENTS` addresses at once, all under one role.
 *
 * Replaces the old single-address `inviteUser`. There is no resend
 * fallback here — an address with an existing pending invite (regardless of
 * expiry — see the pending-query note below) is skipped, never resent.
 * Resending happens exclusively through the dedicated `resendInvitation`
 * action (the per-row RESEND button).
 *
 * The expensive reads (inviter/company docs, the full members collection,
 * the full pending-invitations collection) happen exactly once regardless
 * of how many addresses were submitted; only the seat guard and the writes
 * scale with N.
 */
export async function inviteUsers(emails: string[], role: Role): Promise<InviteUsersResult> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Harden input — never trust the client's parser ────────────────────────
  if (!Array.isArray(emails)) return { error: 'Invalid recipient list.' }

  const submittedRole: Role = toRole(role, { fn: 'inviteUsers', path: `companies/${cid}` })

  const seen = new Set<string>()
  const normalizedEmails: string[] = []
  for (const raw of emails) {
    if (typeof raw !== 'string') continue
    const email = normalizeEmail(raw)
    if (email.length === 0 || email.length > 254) continue
    if (!EMAIL_RE.test(email)) continue
    if (seen.has(email)) continue
    seen.add(email)
    normalizedEmails.push(email)
  }

  if (normalizedEmails.length === 0) return { error: 'Enter at least one valid email address.' }
  if (normalizedEmails.length > MAX_RECIPIENTS) {
    return { error: `Too many recipients — max ${MAX_RECIPIENTS} per batch.` }
  }

  // App URL is required to build the accept link.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    console.error('[actions/team]', { companyId: cid, action: 'invite_users', error: 'NEXT_PUBLIC_APP_URL not set' })
    return { error: 'Server is misconfigured — please contact support.' }
  }

  // ── 3. Four reads total, regardless of N ──────────────────────────────────────
  // Replaces both the old per-address "already a member?" query and the
  // three count() aggregates the seat guard used to run: the two collection
  // reads below give exact counts AND the email sets needed for
  // classification in one pass.
  const [inviterSnap, companySnap, membersSnap, pendingSnap] = await Promise.all([
    adminDb.doc(`companies/${cid}/members/${session.uid}`).get(),
    adminDb.doc(`companies/${cid}`).get(),
    adminDb.collection(`companies/${cid}/members`).get(),
    adminDb.collection(`companies/${cid}/invitations`).where('status', '==', 'pending').get(),
  ])

  const inviterName = (inviterSnap.data()?.name as string) || session.email || 'A teammate'
  const companyName = (companySnap.data()?.name as string) || 'your team'

  // `docToMember` (lib/queries/members.ts) doesn't lowercase email — do it here.
  const memberEmails = new Set(
    membersSnap.docs
      .map((doc) => (doc.data().email as string | undefined)?.toLowerCase())
      .filter((email): email is string => Boolean(email)),
  )

  const pendingDocs = pendingSnap.docs.map((doc) => doc.data() as Invitation)
  // Skip rule: any address with a `status == 'pending'` invite is skipped,
  // regardless of expiry. Treating an expired pending invite as "free to
  // re-invite" would create a second pending doc for the same address,
  // double-counting it in every future seat calculation and showing two
  // rows in the pending list — the address is still visible with its own
  // RESEND button, which is exactly where re-sending an expired link belongs.
  const invitedEmails = new Set(pendingDocs.map((doc) => doc.email.toLowerCase()))

  // ── 4. Classify ────────────────────────────────────────────────────────────
  const classified = classifyRecipients(normalizedEmails, { members: memberEmails, invited: invitedEmails })

  const toCreate: string[] = []
  const skipped: { email: string; reason: InviteSkipReason }[] = []
  for (const c of classified) {
    if (c.state === 'new') toCreate.push(c.email)
    else skipped.push({ email: c.email, reason: c.state })
  }

  if (toCreate.length === 0) {
    return { invitations: [], skipped }
  }

  // ── 5. Seat guard — evaluated ONCE, against a snapshot PLUS the batch size,
  // before any write. Running the old per-address count() guard in a loop
  // would let N invitations through against a single free seat, since
  // uncommitted writes are invisible to count(). ─────────────────────────────
  const seatLimit = (companySnap.data()?.subscription?.limits?.users) as number | undefined

  if (typeof seatLimit === 'number') {
    const seatsUsed = computeSeatsUsed(membersSnap.size, pendingDocs)
    if (seatsUsed + toCreate.length > seatLimit) {
      return {
        error: `Seat limit reached (${seatLimit}). Upgrade your plan or revoke unused invitations to add more.`,
      }
    }
  } else {
    console.error('[actions/team]', {
      companyId: cid,
      action: 'invite_users_seat_guard',
      error: 'subscription.limits.users missing or not a number — skipping seat guard',
    })
  }

  // ── 6. Build the batch, commit once — invite doc, mirror doc, AND mail doc
  // for every address, all in the same WriteBatch. A batch is atomic, so it's
  // impossible to mail an accept link to an invite document that doesn't
  // exist (the unrecoverable failure mode: /invite/{token} 404s with no way
  // forward for the invitee). `onMailQueued` is an onDocumentCreated trigger
  // and fires the same way on batched creates.
  // 25 addresses × 3 writes = 75, well under BATCH_LIMIT (490) — no chunking. ─
  const nowIso = new Date().toISOString()
  // Issue #325 (mail retention): shared across every mail doc this loop
  // queues, so all of them get the exact same `expireAt` rather than each
  // drifting by however long the loop takes to run.
  const now = Timestamp.now()
  const expiresAt = newExpiresAt()
  const batch = adminDb.batch()
  const invitations: PublicInvitation[] = []

  for (const email of toCreate) {
    const token = randomBytes(16).toString('hex') // 32-char alphanumeric token (matches [a-zA-Z0-9] across the accept flow)
    const inviteRef = adminDb.collection(`companies/${cid}/invitations`).doc()
    const mirrorRef = adminDb.collection('invitations').doc(token)
    const mailRef = adminDb.collection('mail').doc()

    // Full record — read by acceptInvitationByToken (role) and revocation later.
    batch.set(inviteRef, {
      id: inviteRef.id,
      email,
      role: submittedRole,
      invitedBy: session.uid,
      invitedByName: inviterName,
      invitedAt: nowIso,
      status: 'pending',
      token,
      expiresAt,
    })
    // Public mirror — resolved by the /invite/{token} page and accept callable.
    // `expireAt` (issue #297) is the Firestore TTL field declared in
    // firestore.indexes.json's fieldOverrides — see `mirrorExpireAt`'s
    // docblock for why it's a separate field from `expiresAt`.
    batch.set(mirrorRef, {
      companyId: cid,
      inviteId: inviteRef.id,
      email,
      status: 'pending',
      expiresAt,
      expireAt: mirrorExpireAt(expiresAt),
    })
    // Enqueued mail — sent by the onMailQueued Cloud Function.
    const acceptUrl = `${appUrl.replace(/\/$/, '')}/invite/${token}`
    batch.set(mailRef, {
      to: email,
      template: 'invitation',
      data: { companyName, inviterName, acceptUrl, role: submittedRole },
      status: 'queued',
      companyId: cid,
      priority: 'normal',
      expireAt: mailExpireAt(now),
      createdAt: nowIso,
    })

    invitations.push({
      id: inviteRef.id,
      email,
      role: submittedRole,
      invitedBy: session.uid,
      invitedByName: inviterName,
      invitedAt: nowIso,
      status: 'pending',
      expiresAt,
    })
  }

  await batch.commit()

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid: session.uid.slice(0, 8) + '...',
    companyId: cid,
    action: 'invite_users',
    count: invitations.length,
    skipped: skipped.length,
  })

  return { invitations, skipped }
}

/**
 * Dedicated resend for the team page's per-row RESEND button — lets the UI
 * resend without re-posting the whole invite form. This is now the ONLY
 * caller of `extendPendingInvite` — `inviteUsers` has no resend branch of
 * its own, it skips already-invited addresses instead.
 */
export async function resendInvitation(inviteId: string): Promise<{ error?: string }> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Read the private doc — cheap early exit for a bad request (missing,
  // or already not pending) and to get the role/name for the mail content.
  // This is NOT the authority for the actual write: extendPendingInvite
  // (below) re-reads this same doc inside a transaction and re-verifies
  // `status === 'pending'` there before writing anything — see its docblock
  // for the revoke/accept race this closes. Never accept a token from the
  // client either way. ──────────────────────────────────────────────────────
  const inviteRef = adminDb.doc(`companies/${cid}/invitations/${inviteId}`)
  const inviteSnap = await inviteRef.get()
  if (!inviteSnap.exists) return { error: 'Invitation not found' }

  const inviteData = inviteSnap.data()!
  if (inviteData.status !== 'pending') {
    return { error: 'Only pending invitations can be resent' }
  }

  const role = toRole(inviteData.role, { fn: 'resendInvitation', path: inviteRef.path })
  const inviterName = (inviteData.invitedByName as string) || 'A teammate'

  // App URL is required to rebuild the accept link.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    console.error('[actions/team]', { companyId: cid, action: 'resend_invitation', error: 'NEXT_PUBLIC_APP_URL not set' })
    return { error: 'Server is misconfigured — please contact support.' }
  }

  // ── 3. Extend expiry + stamp lastSentAt, and recreate the mirror if TTL
  // already deleted it — all inside one transaction that re-verifies
  // `status === 'pending'` against its own fresh read (see
  // extendPendingInvite's docblock). `email`/`token` below come from THAT
  // read, not from the pre-check above. ─────────────────────────────────────
  const result = await extendPendingInvite(cid, inviteId)
  if (!result.ok) {
    // The invite stopped being pending between the pre-check above and the
    // transaction's own read — e.g. a concurrent revoke or accept. Same
    // user-facing message as the pre-check's non-pending case. No mail is
    // queued below this point: the mirror was never recreated.
    return { error: 'Only pending invitations can be resent' }
  }
  const { email, token } = result

  // ── 4. Re-queue the email — only reached once the transaction above
  // actually committed a fresh, live pending mirror. ────────────────────────
  const companySnap = await adminDb.doc(`companies/${cid}`).get()
  const companyName = (companySnap.data()?.name as string) || 'your team'
  const acceptUrl = `${appUrl.replace(/\/$/, '')}/invite/${token}`

  await adminDb.collection('mail').add({
    to: email,
    template: 'invitation',
    data: { companyName, inviterName, acceptUrl, role },
    status: 'queued',
    companyId: cid,
    priority: 'normal',
    createdAt: new Date().toISOString(),
    // Issue #325 (mail retention): no `now` already in scope here, so a
    // fresh one is taken at write time — see lib/mail-retention.ts.
    expireAt: mailExpireAt(Timestamp.now()),
  })

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid: session.uid.slice(0, 8) + '...',
    companyId: cid,
    inviteId,
    action: 'resend_invitation',
  })

  return {}
}

/** Typed sentinel thrown inside `updateMemberRole`'s, `removeMember`'s and
 * `leaveCompany`'s transactions, mapped to a user-facing string in each catch
 * block — same pattern as `actions/equipment.ts`'s `createEquipment`. */
type MemberGuardError = Error & { code: 'not-found' | 'sole-admin' | 'sole-member' }

function guardError(code: MemberGuardError['code'], message: string): MemberGuardError {
  return Object.assign(new Error(message), { code })
}

const CANNOT_DEMOTE_SOLE_ADMIN = 'Cannot demote the only admin. Promote another member first.'
const CANNOT_LEAVE_SOLE_ADMIN = 'Cannot leave — you are the only administrator. Promote another member first.'

/**
 * Changes `memberId`'s role within the caller's active company.
 *
 * Runs inside a `runTransaction`: reads `_meta/memberCounts`
 * (`readMemberCounts`, lib/companyStats.ts) and the target's own member doc,
 * refuses to demote the company's only admin, and otherwise writes both role
 * docs plus the memberCounts delta atomically. A same-role call is a true
 * no-op — zero writes, no claims sync, not even the self-heal write.
 * Custom-claims sync (for the target's OWN active session) happens after
 * commit and is non-fatal on failure, matching `removeMember` below.
 * `revokeRefreshTokens` runs unconditionally after that — see its own
 * comment below for why a no-op role change skips it while every real role
 * change gets it regardless of the target's currently-active company, and
 * for how this differs from `switchCompany`'s use of the same call.
 */
export async function updateMemberRole(
  memberId: string,
  newRole: Role,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  if (!ALLOWED_ROLES.includes(newRole)) return { error: 'Invalid role' }

  if (memberId === session.uid) return { error: "You can't change your own role" }

  const companyId = session.activeCompanyId
  if (!companyId) return { error: 'No active company' }

  const memberRef         = adminDb.doc(`companies/${companyId}/members/${memberId}`)
  const userMembershipRef = adminDb.doc(`users/${memberId}/memberships/${companyId}`)

  let isNoOp = false

  try {
    await adminDb.runTransaction(async (tx) => {
      // Reads first, in either order — readMemberCounts no longer writes
      // during its read phase (see lib/companyStats.ts), so unlike the
      // pre-hardening plan there is no ordering requirement between this and
      // the member-doc read below. `applyHeal()` (called further down) is the
      // one operation that MUST come after every read and before every write.
      const [counts, memberSnap] = await Promise.all([
        readMemberCounts(tx, companyId),
        tx.get(memberRef),
      ])

      if (!memberSnap.exists) {
        throw guardError('not-found', 'Member not found')
      }

      const oldRole = memberSnap.data()!.role as string

      // No-op: same role in, same role out. Deliberately zero writes and no
      // claims sync — not even the self-heal write, so a role-check that
      // changes nothing never has a side effect. (The counter still heals
      // itself on the next call that actually needs to write.) Returning here
      // commits an empty transaction.
      if (oldRole === newRole) {
        isNoOp = true
        return
      }

      const adminsDelta: -1 | 0 | 1 =
        (newRole === 'admin' ? 1 : 0) - (oldRole === 'admin' ? 1 : 0) as -1 | 0 | 1

      if (adminsDelta === -1 && counts.admins <= 1) {
        throw guardError('sole-admin', CANNOT_DEMOTE_SOLE_ADMIN)
      }

      // Only now, once neither guard has thrown, persist the heal — a throw
      // above discards the whole transaction (including an unpersisted heal),
      // which is fine: the next caller heals it again from the same live
      // aggregate.
      counts.applyHeal()

      tx.update(memberRef, { role: newRole })
      tx.update(userMembershipRef, { role: newRole })
      memberCountsDelta(tx, companyId, { members: 0, admins: adminsDelta })
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'not-found') return { error: 'Member not found' }
    if (code === 'sole-admin') return { error: CANNOT_DEMOTE_SOLE_ADMIN }

    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      companyId,
      target: memberId.slice(0, 8) + '...',
      error: message,
      action: 'update_member_role_guard_failed',
    })
    return { error: "Could not verify this company's administrators right now. No changes were made." }
  }

  if (isNoOp) return {}

  // Claims sync stays outside the transaction and after commit, unchanged in
  // form from before this guard existed: `setCustomUserClaims` cannot itself
  // be transactional, and putting it inside the callback would re-run it on
  // every Firestore-level retry. Non-fatal on failure — the membership change
  // has already committed — same pattern as removeMember's claims section.
  try {
    const authUser = await adminAuth.getUser(memberId)
    const claims = (authUser.customClaims ?? {}) as Record<string, unknown>
    if (claims['activeCompanyId'] === companyId) {
      await adminAuth.setCustomUserClaims(memberId, {
        activeCompanyId: companyId,
        role: newRole,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      target: memberId.slice(0, 8) + '...',
      companyId,
      error: message,
      action: 'update_member_role_claims_update_failed',
    })
  }

  // `revokeRefreshTokens` closes the gap the guard above leaves open:
  // `getVerifiedSession` (lib/dal.ts) reads `role` only from the session
  // cookie, never from Firestore, so without revocation a just-demoted admin
  // keeps passing every `session.role !== 'admin'` guard in the app for as
  // long as their existing cookie/refresh token lives — up to 14 days. The
  // PR-2 counter guard stops a demotion from taking a company to zero admins,
  // but does nothing to stop the demoted user from continuing to act as one
  // in the meantime.
  //
  // `switchCompany` (actions/auth.ts) already revokes, for the same reason,
  // but the difference here is who it happens to and what they experience:
  // `switchCompany` revokes the CALLER's own tokens, and the same request
  // that triggered it re-issues a fresh session immediately after (see that
  // function's docblock — the caller is TOLD to call getIdToken(true) then
  // createSession()). Here the target is a DIFFERENT, possibly
  // currently-active user with no way to be handed a fresh token: their
  // existing session cookie simply stops verifying, and they are bounced to
  // /login on their very next server request, mid-session, with no warning.
  // That is a real, user-visible behaviour change, not merely a hardening
  // detail, and is worth stating explicitly so the next reader doesn't
  // mistake it for an accident.
  //
  // Deliberately its own try/catch, run UNCONDITIONALLY — not nested inside
  // the `if (claims['activeCompanyId'] === companyId)` branch above, and not
  // skipped when that branch's own `setCustomUserClaims` call fails. The role
  // that changed lives on `companies/{companyId}/members/{memberId}`
  // (already committed by the transaction above) regardless of which company
  // the target currently has active or whether their Auth claims could be
  // refreshed just now; a future `switchCompany` back into this company must
  // not be able to succeed on a refresh token minted before this
  // demotion/promotion. Kept in a separate try/catch (rather than one block
  // wrapping both calls) specifically so a revoke failure logs under its own
  // `action` string below, distinguishable in Cloud Logging from a claims
  // failure above — the state after "claims updated, then revoke threw" is
  // materially different (the new role IS on the Auth record for the next
  // fresh sign-in, but the CURRENT session cookie remains valid until its own
  // expiry — exactly the window this call exists to close) from "claims
  // never updated at all", and an operator investigating needs to be able to
  // tell those apart without reading stack traces.
  try {
    await adminAuth.revokeRefreshTokens(memberId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      target: memberId.slice(0, 8) + '...',
      companyId,
      error: message,
      action: 'update_member_role_revoke_tokens_failed',
    })
  }

  revalidatePath('/settings/team')
  return {}
}

/**
 * Anonymises `uid`'s references throughout `cid`'s bookings, equipment,
 * units and the company doc's own `createdBy` — the uid is replaced with
 * `null` everywhere it appears, in a chunked `WriteBatch`.
 *
 * Extracted from `removeMember` so `leaveCompany` (self-service) can apply
 * the exact same anonymisation an admin-initiated removal already does,
 * without the two copies drifting — the design for issue #352 explicitly
 * wants a leaver's bookings anonymised the same way a removed member's are.
 */
async function anonymizeMemberReferences(cid: string, uid: string): Promise<void> {
  let batch = adminDb.batch()
  let opCount = 0

  async function addOp(
    ref: FirebaseFirestore.DocumentReference,
    data: Record<string, null | string>,
  ) {
    batch.update(ref, data)
    opCount++
    if (opCount >= BATCH_LIMIT) {
      batch = await commitAndReset(batch)
      opCount = 0
    }
  }

  const bookingsRef  = adminDb.collection(`companies/${cid}/bookings`)
  const equipmentRef = adminDb.collection(`companies/${cid}/equipment`)
  const companyRef   = adminDb.doc(`companies/${cid}`)

  // Bookings: userId
  const byUserId = await bookingsRef.where('userId', '==', uid).get()
  for (const doc of byUserId.docs) await addOp(doc.ref, { userId: null, userName: null })

  // Bookings: cancelledBy
  const byCancelledBy = await bookingsRef.where('cancelledBy', '==', uid).get()
  for (const doc of byCancelledBy.docs) await addOp(doc.ref, { cancelledBy: null })

  // Bookings: approverId
  const byApproverId = await bookingsRef.where('approverId', '==', uid).get()
  for (const doc of byApproverId.docs) await addOp(doc.ref, { approverId: null })

  // Equipment: createdBy
  const byCreatedBy = await equipmentRef.where('createdBy', '==', uid).get()
  for (const doc of byCreatedBy.docs) await addOp(doc.ref, { createdBy: null })

  // Equipment: approverId
  const byEquipmentApprover = await equipmentRef.where('approverId', '==', uid).get()
  for (const doc of byEquipmentApprover.docs) await addOp(doc.ref, { approverId: null })

  // Units: iterate equipment subcollections directly — avoids collectionGroup index requirement
  const allEquipmentSnap = await equipmentRef.get()
  for (const eqDoc of allEquipmentSnap.docs) {
    const unitsSnap = await eqDoc.ref.collection('units').get()
    for (const doc of unitsSnap.docs) {
      const data = doc.data()
      const updates: Record<string, null> = {}
      if (data.createdBy === uid)     updates.createdBy = null
      if (data.updatedBy === uid)     updates.updatedBy = null
      if (data.deactivatedBy === uid) updates.deactivatedBy = null
      if (Object.keys(updates).length > 0) await addOp(doc.ref, updates)
    }
  }

  // Company doc: createdBy. Confirmed empirically (throwaway script against
  // allocate-alpha, deleted after use) that a single WriteBatch permits more
  // than one write to the same document — companies/{cid} already received
  // its `_meta/memberCounts` + `stats.memberCount` writes in the caller's
  // transaction, and this createdBy write here, in a separate WriteBatch
  // entirely, is safe as an independent write rather than something that
  // needs to be merged with those.
  const companySnap = await companyRef.get()
  if (companySnap.exists && companySnap.data()?.createdBy === uid) {
    await addOp(companyRef, { createdBy: null })
  }

  // operatorFeedback: top-level collection (submitFeedback.ts), keyed by a
  // human-readable ticketId rather than under companies/{cid}. Scoped to
  // this company with a second equality filter — both are equality (`==`),
  // so no composite index is needed. Issue #338 PR 1.
  const feedbackRef = adminDb.collection('operatorFeedback')
  const byFeedbackSubmitter = await feedbackRef
    .where('submittedBy', '==', uid)
    .where('companyId', '==', cid)
    .get()
  for (const doc of byFeedbackSubmitter.docs) await addOp(doc.ref, { submittedBy: null, userName: null })

  await batch.commit()
}

/**
 * Removes `memberId` from the caller's active company (companies/{cid} and
 * users/{memberId} sides) and anonymises their uid references throughout the
 * company's bookings/equipment/units/invitations.
 *
 * The sole-admin guard, the two membership deletes, and the memberCounts
 * delta all run inside one `runTransaction` — see the comment at that guard
 * for why this closes a TOCTOU race the old count()-then-WriteBatch shape
 * had. The anonymisation pass, and the target's activeCompanyId/claims sync,
 * happen afterward in a separate WriteBatch and are unrelated to the guard.
 */
export async function removeMember(memberId: string): Promise<{ error?: string }> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // Self-removal is not allowed — admin must use "leave company" or delete account
  if (memberId === session.uid) return { error: 'You cannot remove yourself. Use "Leave company" instead.' }

  // ── 2. Sole-admin guard + membership deletes (transaction) ───────────────────
  //
  // The read-check-write used to be a plain `count()` query (TOCTOU: two
  // concurrent removals of two different admins could each read count=2 and
  // both pass) followed by a separate WriteBatch. Both the guard and the two
  // membership deletes now live inside one transaction, so Firestore's own
  // serialization is what makes the check-then-act atomic — the second of two
  // concurrent removeMember calls on the last two admins now sees the first
  // one's decrement and is rejected, instead of both racing through.
  //
  // What used to be a hand-maintained "same batch chunk" invariant (see the
  // git history of this function for the old comment) — the member delete and
  // the count decrement must never be split across two separate commits, or a
  // partial failure leaves the member gone but the count stale — is now a
  // transaction guarantee instead of a chunk-counting one: either both writes
  // below commit together, or neither does.
  const targetMemberRef   = adminDb.doc(`companies/${cid}/members/${memberId}`)
  const userMembershipRef = adminDb.doc(`users/${memberId}/memberships/${cid}`)

  try {
    await adminDb.runTransaction(async (tx) => {
      const [counts, targetSnap] = await Promise.all([
        readMemberCounts(tx, cid),
        tx.get(targetMemberRef),
      ])

      if (!targetSnap.exists) {
        throw guardError('not-found', 'Member not found')
      }

      const targetRole = targetSnap.data()!.role as string | undefined

      if (targetRole === 'admin' && counts.admins <= 1) {
        throw guardError('sole-admin', 'Cannot remove the only admin. Promote another member first.')
      }

      // Only now, once the guard hasn't thrown, persist the heal — see
      // updateMemberRole above for why a throw must discard it instead.
      counts.applyHeal()

      tx.delete(targetMemberRef)
      tx.delete(userMembershipRef)
      memberCountsDelta(tx, cid, { members: -1, admins: targetRole === 'admin' ? -1 : 0 })
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'not-found') return { error: 'Member not found' }
    if (code === 'sole-admin') return { error: 'Cannot remove the only admin. Promote another member first.' }

    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      companyId: cid,
      target: memberId.slice(0, 8) + '...',
      error: message,
      action: 'remove_member_guard_failed',
    })
    return { error: "Could not verify this company's administrators right now. No changes were made." }
  }

  // ── 3. Anonymize uid-references scoped to this company (WriteBatch) ──────────
  await anonymizeMemberReferences(cid, memberId)

  // ── 5. Handle target's activeCompanyId server-side ───────────────────────────
  try {
    const targetUserSnap = await adminDb.doc(`users/${memberId}`).get()
    const targetUser = targetUserSnap.data() ?? {}

    if (targetUser.activeCompanyId === cid) {
      // List remaining memberships after removal
      const remainingMembershipsSnap = await adminDb
        .collection(`users/${memberId}/memberships`)
        .get()

      if (remainingMembershipsSnap.docs.length > 0) {
        const nextDoc = remainingMembershipsSnap.docs[0]
        const next = nextDoc.data()
        const nextCompanyId = next.companyId as string
        const nextRole      = toRole(next.role, { fn: 'removeMember', path: nextDoc.ref.path })

        await adminDb.doc(`users/${memberId}`).update({ activeCompanyId: nextCompanyId })
        await adminAuth.setCustomUserClaims(memberId, {
          activeCompanyId: nextCompanyId,
          role: nextRole,
        })
      } else {
        await adminDb.doc(`users/${memberId}`).update({ activeCompanyId: null })
        await adminAuth.setCustomUserClaims(memberId, {
          activeCompanyId: null,
          role: null,
        })
      }
    }
  } catch (err) {
    // Non-fatal: log and continue — membership is already revoked
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      target: memberId.slice(0, 8) + '...',
      companyId: cid,
      error: message,
      action: 'remove_member_claims_update_failed',
    })
  }

  // ── 6. Revalidate + log ──────────────────────────────────────────────────────
  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid:       session.uid.slice(0, 8) + '...',
    target:    memberId.slice(0, 8) + '...',
    companyId: cid,
    action:    'remove_member',
  })

  return {}
}

export interface LeaveCompanyResult {
  error?: string
  /** The caller is the company's sole admin and other members remain — UI
   *  shows a picker to promote one of `promotable` before leaving is possible.
   *  Same shape `getLeaveContext` (actions/companies.ts) returns, so the UI
   *  can show the list before the guard ever trips and still accept this one
   *  when a stale advisory outcome sends it down the write path first. */
  blocked?: { promotable: { uid: string; name: string; email: string; role: Role }[] }
  /** The caller is the company's only member — there is nobody to leave it
   *  to. UI routes into the EXISTING company-deletion confirm flow
   *  (requestCompanyDeletion) instead of a new mechanism. */
  onlyMember?: { companyName: string }
  /**
   * Leaving succeeded. `sessionRefresh` is set only when `companyId` was the
   * caller's ACTIVE company — leaving a non-active membership (the common
   * case from Account Settings' "My companies" list) changes nothing about
   * the caller's current session, so there is nothing to refresh. When set,
   * `customToken` is required to re-establish a session — see
   * switchCompany's docblock (actions/auth.ts): `revokeRefreshTokens` below
   * invalidates the caller's own refresh token too, so `getIdToken(true)`
   * cannot be used afterward. `redirectCompanyId` is the membership to
   * switch into, or null if none remain (→ /no-company).
   */
  left?: { sessionRefresh: { redirectCompanyId: string | null; customToken: string } | null }
}

/**
 * Self-service leave of `companyId` (issue #352) — `removeMember`'s error
 * message has pointed here since before this function existed: "Use 'Leave
 * company' instead." Same transactional sole-admin guard as `removeMember`/
 * `updateMemberRole` (`readMemberCounts`/`memberCountsDelta`,
 * lib/companyStats.ts), plus a sole-MEMBER guard neither of those needs
 * (removing or demoting someone else never empties a company).
 *
 * `companyId` need not be the caller's currently active company — the
 * design's primary entry point (Account Settings → "My companies") lists
 * every membership and lets each be left directly, not just the active one.
 * Authorization is the same either way: the transaction below only
 * proceeds if `companies/{companyId}/members/{session.uid}` exists, exactly
 * as `switchCompany` (actions/auth.ts) validates a membership rather than
 * trusting `session.activeCompanyId`.
 *
 * No `memberId` parameter — this is always self-service, `session.uid`
 * throughout. Three outcomes, decided by the SAME transaction that would
 * perform the write:
 *   - sole member  → nothing written; caller routes to the existing
 *     `requestCompanyDeletion` confirm flow (actions/companyDeletion.ts).
 *     This function never calls it — no parallel deletion mechanism.
 *   - sole admin, others remain → nothing written; caller shows a promote
 *     picker, promotes via the EXISTING `updateMemberRole`, then calls this
 *     again (now falls through to the branch below).
 *   - otherwise → transactional delete (mirrors removeMember), then the
 *     same anonymisation pass `removeMember` applies to a removed member,
 *     and — ONLY when `companyId` was the caller's active company — a
 *     claims/activeCompanyId repoint to a remaining membership (or null)
 *     plus an UNCONDITIONAL `revokeRefreshTokens` (see `left` above — this
 *     is the one deliberate difference from `removeMember`'s
 *     target-repoint: removing someone ELSE doesn't need to revoke their
 *     tokens for the guard to hold, but leaving your OWN active company
 *     must "revoke access across all sessions" per the design, and only
 *     self-service can even do that), and always a queued receipt email.
 */
export async function leaveCompany(companyId: string): Promise<LeaveCompanyResult> {
  const session = await getVerifiedSession()
  const cid = companyId
  const isActiveCompany = session.activeCompanyId === cid

  const selfMemberRef     = adminDb.doc(`companies/${cid}/members/${session.uid}`)
  const userMembershipRef = adminDb.doc(`users/${session.uid}/memberships/${cid}`)

  try {
    await adminDb.runTransaction(async (tx) => {
      const [counts, selfSnap] = await Promise.all([
        readMemberCounts(tx, cid),
        tx.get(selfMemberRef),
      ])

      if (!selfSnap.exists) {
        throw guardError('not-found', 'Membership not found')
      }

      const myRole = selfSnap.data()!.role as string | undefined

      // Checked before sole-admin: a company with exactly one member is that
      // member's own company regardless of role — always an admin in
      // practice (the founder), but the member count is the real question
      // here, not the role.
      if (counts.members <= 1) {
        throw guardError('sole-member', 'You are the only member')
      }

      if (myRole === 'admin' && counts.admins <= 1) {
        throw guardError('sole-admin', CANNOT_LEAVE_SOLE_ADMIN)
      }

      // Only now, once neither guard has thrown, persist the heal — see
      // removeMember above for why a throw must discard it instead.
      counts.applyHeal()

      tx.delete(selfMemberRef)
      tx.delete(userMembershipRef)
      memberCountsDelta(tx, cid, { members: -1, admins: myRole === 'admin' ? -1 : 0 })
    })
  } catch (err) {
    const code = (err as { code?: string }).code

    if (code === 'sole-member') {
      const companySnap = await adminDb.doc(`companies/${cid}`).get()
      return { onlyMember: { companyName: (companySnap.data()?.name as string | undefined) ?? '' } }
    }

    if (code === 'sole-admin') {
      const members = await listMembers(cid)
      const promotable = members
        .filter((m) => m.uid !== session.uid)
        .map((m) => ({ uid: m.uid, name: m.name, email: m.email, role: m.role }))
      return { blocked: { promotable } }
    }

    if (code === 'not-found') return { error: 'Membership not found' }

    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      companyId: cid,
      uid: session.uid.slice(0, 8) + '...',
      error: message,
      action: 'leave_company_guard_failed',
    })
    return { error: "Could not verify this company's administrators right now. No changes were made." }
  }

  // Anonymize the leaver's own references — same treatment `removeMember`
  // gives a removed member.
  await anonymizeMemberReferences(cid, session.uid)

  // Session repoint — ONLY when the company just left was the caller's
  // active one. Leaving a non-active membership (the common case from
  // Account Settings' "My companies" list) changes nothing the caller's
  // current session depends on: no claims change, no revoke, no custom
  // token, just the plain `router.refresh()` the client does on its own.
  let sessionRefresh: { redirectCompanyId: string | null; customToken: string } | null = null

  if (isActiveCompany) {
    let redirectCompanyId: string | null = null
    try {
      const remainingSnap = await adminDb.collection(`users/${session.uid}/memberships`).get()

      if (remainingSnap.docs.length > 0) {
        const nextDoc = remainingSnap.docs[0]!
        const next = nextDoc.data()
        redirectCompanyId = next.companyId as string
        const nextRole = toRole(next.role, { fn: 'leaveCompany', path: nextDoc.ref.path })
        await adminDb.doc(`users/${session.uid}`).update({ activeCompanyId: redirectCompanyId })
        await adminAuth.setCustomUserClaims(session.uid, {
          activeCompanyId: redirectCompanyId,
          role: nextRole,
        })
      } else {
        await adminDb.doc(`users/${session.uid}`).update({ activeCompanyId: null })
        await adminAuth.setCustomUserClaims(session.uid, { activeCompanyId: null, role: null })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[actions/team]', {
        uid: session.uid.slice(0, 8) + '...',
        companyId: cid,
        error: message,
        action: 'leave_company_claims_update_failed',
      })
    }

    // Revoke unconditionally — see this function's docblock and `left`'s own
    // comment above for why leaving your active company (unlike
    // removeMember) must do this for itself, and why the caller needs a
    // custom token afterward instead of a plain token refresh.
    try {
      await adminAuth.revokeRefreshTokens(session.uid)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[actions/team]', {
        uid: session.uid.slice(0, 8) + '...',
        companyId: cid,
        error: message,
        action: 'leave_company_revoke_tokens_failed',
      })
    }

    const customToken = await adminAuth.createCustomToken(session.uid)
    sessionRefresh = { redirectCompanyId, customToken }
  }

  // Receipt email — best-effort, queued the same way every other mail in
  // this file is (onMailQueued Cloud Function delivers it).
  try {
    const companySnap = await adminDb.doc(`companies/${cid}`).get()
    const companyName = (companySnap.data()?.name as string | undefined) ?? ''
    // Same NEXT_PUBLIC_APP_URL convention inviteUsers/resendInvitation use
    // above — but this mail is best-effort (see the enclosing try/catch), so
    // a misconfigured env just skips the receipt rather than failing the
    // leave itself the way those two actions fail outright.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (!appUrl) {
      console.error('[actions/team]', { companyId: cid, action: 'leave_company_mail_skipped', error: 'NEXT_PUBLIC_APP_URL not set' })
    } else {
      const ctaUrl = `${appUrl.replace(/\/$/, '')}/login`
      await adminDb.collection('mail').add({
        to: session.email,
        template: 'leftCompany',
        data: { companyName, ctaUrl },
        status: 'queued',
        companyId: cid,
        priority: 'normal',
        createdAt: new Date().toISOString(),
        // Issue #325 (mail retention): no `now` already in scope here, so a
        // fresh one is taken at write time — see lib/mail-retention.ts.
        expireAt: mailExpireAt(Timestamp.now()),
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      uid: session.uid.slice(0, 8) + '...',
      companyId: cid,
      error: message,
      action: 'leave_company_mail_enqueue_failed',
    })
  }

  // Deliberately NOT calling revalidatePath here when the left company was
  // active — same race actions/auth.ts's switchCompany hit (caught live
  // against alpha, see its docblock): a Server Action invoked from a Client
  // Component eagerly re-renders the invoking route's revalidated segments
  // as part of THIS SAME request/response, using the request's own (still
  // the OLD, now revoked) session cookie — bouncing the client to /login
  // before it ever reaches `establishSessionFromCustomToken`. Every active-
  // company caller already does a hard `window.location.href` reload after
  // that handshake (LeaveCompanyReceipt's CONTINUE), which busts the cache
  // on its own. The non-active case has no such revoke to race against, but
  // skips this uniformly rather than making the hazard depend on a branch a
  // future edit could get wrong — its caller (AccountSettingsForm) already
  // does its own `router.refresh()` on close.
  console.log('[actions/team]', {
    uid: session.uid.slice(0, 8) + '...',
    companyId: cid,
    action: 'leave_company',
  })

  return { left: { sessionRefresh } }
}

export async function revokeInvitation(inviteId: string): Promise<{ error?: string }> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Read the private doc FIRST — it's what gives us the token for the
  // mirror path. Never accept a token from the client. ─────────────────────────
  const inviteRef = adminDb.doc(`companies/${cid}/invitations/${inviteId}`)
  const inviteSnap = await inviteRef.get()
  if (!inviteSnap.exists) return { error: 'Invitation not found' }

  const inviteData = inviteSnap.data()!
  if (inviteData.status !== 'pending') {
    return { error: 'Only pending invitations can be revoked' }
  }

  const token = inviteData.token as string
  const mirrorRef = adminDb.collection('invitations').doc(token)

  // ── 3. Batch-update both documents ────────────────────────────────────────────
  const nowIso = new Date().toISOString()
  const batch = adminDb.batch()
  // `expireAt` (issue #410) is a concrete Timestamp, not a serverTimestamp
  // sentinel — Firestore's TTL service reads the stored value directly. The
  // TTL policy on the `invitations` collection group already covers this
  // private doc, so it's deleted 30 days after revocation — nothing reads a
  // revoked doc again.
  batch.update(inviteRef, {
    status: 'revoked',
    revokedAt: nowIso,
    revokedBy: session.uid,
    expireAt: Timestamp.fromMillis(Date.now() + REVOKED_INVITE_TTL_MS),
  })
  // Issue #297: delete the mirror rather than marking it 'revoked' — it's a
  // publicly readable doc carrying the invitee's email, and a revoked invite
  // can never be used again, so nothing needs it to keep existing.
  batch.delete(mirrorRef)
  await batch.commit()

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid:       session.uid.slice(0, 8) + '...',
    companyId: cid,
    inviteId,
    action:    'revoke_invitation',
  })

  return {}
}
