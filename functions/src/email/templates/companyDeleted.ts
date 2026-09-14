import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export type CompanyDeletionMode = 'window' | 'immediate';

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
   * True when this recipient had no other company and their entire Allocate
   * account — profile, membership, Auth user — was deleted along with this
   * one (see `deletionOutcomes`/member cleanup, PR E). This is a deliberate
   * product decision, not an edge case to soften: an admin decided this,
   * the member got no advance warning, and this email is the only notice
   * she gets, with no undo. Do not "fix" this by skipping the send or
   * softening the copy — see plan/det-k-nns-som-att-stateless-conway.md.
   *
   * Independent of `mode`: a member can lose her only company (and thus her
   * account) whether that company's window ran out or it was deleted
   * immediately as a sole-member company. The two dimensions aren't the
   * same axis — don't assume `mode === 'immediate'` implies this is true,
   * or vice versa.
   */
  accountAlsoDeleted: boolean;
  /**
   * Where the CTA points. Caller picks the right destination for the case:
   * `/company/new` when the account survives, a signup page when it doesn't
   * (there is nothing to sign back into).
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
  const { companyName, requestedByName, requestedAtFormatted, deletedAtFormatted, mode, accountAlsoDeleted, ctaUrl } = data;
  const firstWord = companyName.trim().split(/\s+/)[0] || companyName;

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

  const accountLine = accountAlsoDeleted
    ? `Because ${companyName} was the only company on your account, your Allocate account has been deleted along with it. This email is the only notice you get — there is nothing left to sign back into, and neither we nor support can restore it.`
    : 'The bookings, equipment and shared history are gone. We cannot restore them, and neither can support.';

  const yourAccountValue = accountAlsoDeleted
    ? 'Deleted. This was your only company, so your account went with it — there is nothing to sign back into.'
    : 'Untouched. You can start your own company or wait to be invited.';

  const buttonLabel = accountAlsoDeleted ? 'CREATE AN ACCOUNT' : 'CREATE A COMPANY';

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
