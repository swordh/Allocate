import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export interface BillingEmailMissingData {
  companyName: string;
  /** `/settings/subscription`, already fully qualified. */
  settingsUrl: string;
  /**
   * `false` — the FIRST mail, queued the moment
   * `runAccountDeletion`'s Stripe billing-contact anonymisation
   * (actions/account.ts) clears the customer's email. `true` — every mail
   * after that, queued weekly by
   * `functions/src/company/billingEmailReminder.ts` for as long as the
   * address stays unset. Only changes the eyebrow/eyebrow-adjacent wording;
   * the rest of the copy is identical either way.
   */
  isReminder: boolean;
}

/**
 * "Your billing email is missing" notice — sent to every admin of a company
 * whose Stripe customer lost its billing contact address (see
 * `CompanyBilling` in types/company.ts). Deliberately says NOTHING about how
 * or why the address went missing, and never names a person: the trigger is
 * always one specific member deleting her own account, but this mail's only
 * job is to get a new address set, not to explain a departure that is none
 * of Stripe's, or this mail's, business.
 */
export function billingEmailMissingEmail(data: BillingEmailMissingData): RenderedEmail {
  const { companyName, settingsUrl, isReminder } = data;

  const subject = isReminder
    ? `Reminder: ${companyName} still has no billing email`
    : `${companyName} has no billing email`;

  const introHtml = `<span style="color:#ffffff;">${escapeHtml(
    companyName,
  )}</span>'s billing email was removed, and Stripe currently has no address to send invoices or receipts to. Add one from Settings → Subscription → Manage billing to keep them arriving.`;

  const switchNoteHtml = `If you administer more than one company, switch to <span style="color:#ffffff;">${escapeHtml(
    companyName,
  )}</span> first — Manage billing always opens the currently active company's Stripe portal.`;

  // Tells the recipient this repeats weekly, worded for whichever mail this
  // actually is: the first one warns that more are coming, a repeat
  // confirms it's still the same standing weekly notice, not a new problem.
  const repeatNote = isReminder
    ? `You'll get this reminder weekly until a billing email is added.`
    : `You'll get a reminder like this weekly until a billing email is added.`;

  const text = [
    isReminder
      ? `${companyName} still has no billing email set.`
      : `${companyName} has no billing email set.`,
    '',
    `${companyName}'s billing email was removed, and Stripe currently has no address to send invoices or receipts to. Add one from Settings → Subscription → Manage billing to keep them arriving.`,
    '',
    `If you administer more than one company, switch to ${companyName} first — Manage billing always opens the currently active company's Stripe portal.`,
    '',
    repeatNote,
    '',
    `Open Settings → Subscription: ${settingsUrl}`,
    '',
    `You are getting this because you are an administrator of ${companyName}.`,
  ].join('\n');

  const html = renderLayout({
    preheader: isReminder
      ? `${companyName} still has no billing email — invoices and receipts can't be sent.`
      : `${companyName} has no billing email — invoices and receipts can't be sent.`,
    eyebrow: isReminder ? 'BILLING EMAIL — REMINDER' : 'BILLING EMAIL MISSING',
    hero: ['No billing', 'email'],
    bodyHtml: `${introHtml}<br><br>${switchNoteHtml}`,
    buttonLabel: 'OPEN SUBSCRIPTION SETTINGS',
    buttonUrl: settingsUrl,
    noteHtml: escapeHtml(repeatNote),
    footerSentence: `You are getting this because you are an administrator of ${companyName}.`,
  });

  return { subject, html, text };
}
