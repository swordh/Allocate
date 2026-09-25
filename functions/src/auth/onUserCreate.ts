import * as functions from 'firebase-functions/v1';
import { logger } from 'firebase-functions/v2';

/**
 * Triggered when a new Firebase Auth user is created. Deliberately a no-op
 * (issue #396) — kept exported rather than deleted because removing a
 * deployed trigger needs a manual `functions:delete` in every environment
 * (prod/beta/alpha), and leaving the export in place with an empty body is
 * the safe way to retire it everywhere at once via a normal deploy.
 *
 * This used to scan the invitations collection-group for the new user's
 * email and auto-join them into any matching company, on the theory that a
 * brand-new signup whose address had a pending invite was equivalent to
 * clicking the invite link. It isn't: for the app's actual signup flow
 * (components/auth/SignupForm.tsx, `createUserWithEmailAndPassword`),
 * `user.email` on this trigger is UNVERIFIED — Firebase Auth sets it from
 * whatever address the signup form submitted, before any confirmation round
 * trip, and nothing here (or in Firestore Security Rules) checked
 * `email_verified`. Auto-joining on it meant anyone who knew an invitee's
 * address could sign up as them and walk away with a member doc, custom
 * claims, and the Firestore read access that comes with both — an
 * invitation-hijack, not a convenience.
 *
 * The `/invite/{token}` → `acceptInvitationByToken` link
 * (functions/src/auth/acceptInvitation.ts) is the only path that turns an
 * invitation into a membership. The token — delivered only to the invited
 * address by the mail this trigger has no part in — is what actually proves
 * mailbox ownership; an unverified `email` field on a fresh Auth user proves
 * nothing. This matches how the app has behaved in practice all along, since
 * this trigger's auto-join was broken from the start (issue #396: it read
 * `companyId` off a field the private invitation doc never had, so it never
 * successfully created a membership even before this fix).
 *
 * Reinstating auto-join (e.g. once SSO providers that verify email up front
 * are added) would need, at minimum:
 *   - Trusting `user.email` only when it comes from a provider that verifies
 *     it before the account exists (i.e. `user.emailVerified === true` AND
 *     the provider is one that only ever sets that flag post-verification —
 *     password signups can flip it later, but that's a separate event, not
 *     this trigger).
 *   - Checking the invitation's `expiresAt` before honoring it.
 *   - Setting custom claims only from a value the transaction itself
 *     returns (not a variable closed over and reassigned inside the
 *     callback) — a transaction can retry, and code review on this issue
 *     found the previous `accepted` flag pattern survives retries in a way
 *     that doesn't reflect the winning attempt.
 *   - Never overwriting an existing `activeCompanyId` — the previous version
 *     only guarded "already has a claim" per-invitation, so a user matched
 *     by more than one pending invitation could still have the second
 *     invite's company silently replace the first's.
 *   - Skipping the top-level `invitations/{token}` mirror docs (the
 *     collection-group query matches both them and the private
 *     `companies/{cid}/invitations/{id}` docs) and deriving `companyId`
 *     from the private doc's own path, never from a field it doesn't carry.
 *
 * Runs in europe-west1 (inherited from setGlobalOptions in index.ts).
 */
export const onUserCreate = functions
  .region('europe-west1')
  .auth.user()
  .onCreate(async (user) => {
    logger.info('onUserCreate: no-op (issue #396 — see doc comment)', {
      uid: user.uid.slice(0, 8) + '...',
    });
  });
