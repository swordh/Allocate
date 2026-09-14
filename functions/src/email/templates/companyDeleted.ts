import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export type CompanyDeletionMode = 'window' | 'immediate';

/**
 * What happened to THIS recipient's own account, independent of `mode`.
 * Mirrors `MemberAccountStatus` in functions/src/company/memberCleanup.ts —
 * not imported (that module is server-only purge logic, this one is a pure
 * template), kept in lockstep by hand like every other cross-boundary
 * duplication in this codebase.
 *
 * `kept` — she has at least one other company; nothing about her account
 *   changed.
 * `scheduled` — this was her only company. Her account is NOT deleted — it
 *   is scheduled for deletion thirty days out, and she can still sign in,
 *   export her data, or start a new company (which cancels the schedule).
 *   This branch used to be folded into `kept`'s copy ("Untouched — start
 *   your own company or wait to be invited"), which was actively wrong for
 *   her: her account is not untouched, and "wait to be invited" is the
 *   exact passivity that lets the thirty days run out. See the PR E review
 *   notes this fixed — a real product decision (issue #252 step 5's
 *   "Fattade beslut") shipped without this template ever learning about
 *   the state it created.
 * `already_gone` — her entire Allocate account (profile, membership, Auth
 *   user) was deleted along with this company, with no undo. Reachable
 *   today only via the sole-member-deletes-her-own-account path
 *   (`mode: 'immediate'`, PR F).
 */
export type MemberAccountStatus = 'kept' | 'scheduled' | 'already_gone';

export interface CompanyDeletedData {
  companyName: string;
  requestedByName: string;
  requestedAtFormatted: string;
  deletedAtFormatted: string;
  /**
   * 'window' — the standard seven-day grace period ran its course with
   * nobody stopping it. 'immediate' — the company had exactly one member
   * (this recipient) and was deleted on the spot; there never was a window,
   * and describing one would be a lie in the one email this person is
   * guaranteed to read. See "Ensam-medlem-vakten" in
   * plan/det-k-nns-som-att-stateless-conway.md — this is the same rule,
   * just visible from the copy side instead of the guard side.
   */
  mode: CompanyDeletionMode;
  /**
   * See `MemberAccountStatus` above. Independent of `mode`: a member can
   * reach `scheduled` or `already_gone` whether that company's window ran
   * out or it was deleted immediately as a sole-member company — don't
   * assume `mode === 'immediate'` implies anything about this value, or
   * vice versa.
   */
  accountStatus: MemberAccountStatus;
  /**
   * REQUIRED when `accountStatus === 'scheduled'`, ignored otherwise.
   * Already-formatted, e.g. "12 October 2026" — the caller (purge.ts's
   * finalize phase) reads this from `pendingDeletion.scheduledFor`, the
   * SAME timestamp `cleanupOneMember` wrote. This template never computes
   * or guesses this date; it only ever displays what it's handed.
   */
  pendingDeletionScheduledForFormatted?: string;
  /**
   * Where the CTA points. Caller picks the right destination for the case:
   * `/company/new` when the account is untouched (`kept`), a sign-in page
   * when it's `scheduled` (she needs to act before the deadline, and
   * signing in is the first step for either export or a new company), a
   * signup page when it's `already_gone` (there is nothing to sign back
   * into).
   */
  ctaUrl: string;
}

/**
 * "The company has been deleted" email — sent to every FORMER member (not
 * just admins; this is the one deletion-lifecycle mail members do get,
 * because it's the last chance to reach them at all). Fired from the purge's
 * final phase, after the company document itself is gone, using addresses
 * copied into the ledger before the members subtree was deleted.
 */
export function companyDeletedEmail(data: CompanyDeletedData): RenderedEmail {
  const {
    companyName,
    requestedByName,
    requestedAtFormatted,
    deletedAtFormatted,
    mode,
    accountStatus,
    pendingDeletionScheduledForFormatted,
    ctaUrl,
  } = data;
  const firstWord = companyName.trim().split(/\s+/)[0] || companyName;

  if (accountStatus === 'scheduled' && !pendingDeletionScheduledForFormatted) {
    // Would silently render "on undefined" in the account line below — this
    // is a caller bug (finalize phase must always pass the real
    // `pendingDeletion.scheduledFor`), not something to paper over with a
    // guess. Fail loudly instead of mailing a broken date to the one person
    // who most needs an accurate one.
    throw new Error(
      "companyDeletedEmail: accountStatus 'scheduled' requires pendingDeletionScheduledForFormatted",
    );
  }

  const subject = `${companyName} has been deleted`;

  // The one sentence that has to be true for whichever path got this
  // company here — "the seven days have passed" is simply false for a
  // sole-member company, which is deleted the moment it's requested.
  const preheader =
    mode === 'window'
      ? `The seven days have passed. ${companyName} no longer exists.`
      : `${companyName} has been deleted — it had only one member, so there was no window to stop it.`;

  // In 'immediate' mode the requester and this recipient are, by
  // definition, the same person (a sole-member company's one member is its
  // one admin) — so "as its administrator requested on {date}" narrates
  // her own same-day decision back to her in an odd, distancing third
  // person. Address her directly instead and be plain about why there was
  // no grace period, rather than imply she missed a chance she never had.
  const introHtml =
    mode === 'window'
      ? `The seven days have passed and <span style="color:#ffffff;">${escapeHtml(
          companyName,
        )}</span> has been deleted, as its administrator requested on ${escapeHtml(requestedAtFormatted)}.`
      : `<span style="color:#ffffff;">${escapeHtml(
          companyName,
        )}</span> has been deleted. It had only one member — you — so there was no seven-day window to stop it: the deletion happened right away, on ${escapeHtml(
          deletedAtFormatted,
        )}.`;

  const accountLine =
    accountStatus === 'already_gone'
      ? `Because ${companyName} was the only company on your account, your Allocate account has been deleted along with it. This email is the only notice you get — there is nothing left to sign back into, and neither we nor support can restore it.`
      : accountStatus === 'scheduled'
        ? `The bookings, equipment and shared history are gone. Because ${companyName} was your only company, your account itself is scheduled to be deleted on ${pendingDeletionScheduledForFormatted}. Until then you can still sign in — export your data, or start a new company to cancel the deletion.`
        : 'The bookings, equipment and shared history are gone. We cannot restore them, and neither can support.';

  const yourAccountValue =
    accountStatus === 'already_gone'
      ? 'Deleted. This was your only company, so your account went with it — there is nothing to sign back into.'
      : accountStatus === 'scheduled'
        ? `Scheduled for deletion on ${pendingDeletionScheduledForFormatted}. Sign in before then to export your data or start a new company.`
        : 'Untouched. You are still a member of your other companies.';

  const buttonLabel =
    accountStatus === 'already_gone' ? 'CREATE AN ACCOUNT' : accountStatus === 'scheduled' ? 'SIGN IN' : 'OPEN ALLOCATE';

  const introText =
    mode === 'window'
      ? `The seven days have passed and ${companyName} has been deleted, as its administrator requested on ${requestedAtFormatted}.`
      : `${companyName} has been deleted. It had only one member — you — so there was no seven-day window to stop it: the deletion happened right away, on ${deletedAtFormatted}.`;

  const text = [
    preheader,
    '',
    introText,
    '',
    accountLine,
    '',
    `Requested by: ${requestedByName}, ${requestedAtFormatted}`,
    `Deleted: ${deletedAtFormatted}`,
    `Your account: ${yourAccountValue}`,
    'Kept: Invoice records only — accounting law requires them.',
    '',
    `${buttonLabel}: ${ctaUrl}`,
    '',
    `You are getting this because you were a member of ${companyName}.`,
  ].join('\n');

  const html = renderLayout({
    preheader,
    eyebrow: `COMPANY DELETED · ${deletedAtFormatted}`,
    eyebrowAccent: 'red',
    hero: [firstWord, 'is gone'],
    bodyHtml: `${introHtml}<br><br>${escapeHtml(accountLine)}`,
    dataRows: [
      { label: 'REQUESTED BY', value: `${requestedByName}, ${requestedAtFormatted}` },
      { label: 'DELETED', value: deletedAtFormatted, labelAccent: 'red' },
      { label: 'YOUR ACCOUNT', value: yourAccountValue },
      { label: 'KEPT', value: 'Invoice records only — accounting law requires them.' },
    ],
    buttonLabel,
    buttonUrl: ctaUrl,
    showFallbackLink: false,
    footerSentence: `You are getting this because you were a member of ${companyName}.`,
  });

  return { subject, html, text };
}
