/**
 * Renders the four transactional email templates with representative data
 * and writes them to a gitignored directory for visual review.
 *
 * Run with: npx tsx tools/renderEmailPreviews.ts
 * (from functions/)
 *
 * Output: functions/tools/__previews__/*.html — compare against the design
 * handoff files at 600px and at ~400px (resize the browser to exercise the
 * @media(max-width:620px) block).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invitationEmail } from '../src/email/templates/invitation';
import { verifyEmailEmail } from '../src/email/templates/verifyEmail';
import { resetPasswordEmail } from '../src/email/templates/resetPassword';
import { changeEmailEmail } from '../src/email/templates/changeEmail';
import { companyDeletionRequestedEmail } from '../src/email/templates/companyDeletionRequested';
import { companyDeletionReminderEmail } from '../src/email/templates/companyDeletionReminder';
import { companyDeletionCancelledEmail } from '../src/email/templates/companyDeletionCancelled';
import { companyDeletedEmail } from '../src/email/templates/companyDeleted';

const outDir = join(__dirname, '__previews__');
mkdirSync(outDir, { recursive: true });

const renders: Record<string, string> = {
  'invitation.html': invitationEmail({
    companyName: 'Nordfilm AB',
    inviterName: 'Erik Lundqvist',
    acceptUrl: 'https://allocate.at/invite/accept?token=REPLACE_ME',
    role: 'crew',
  }).html,
  'invitation-long-name.html': invitationEmail({
    companyName: 'Scandinavian Motion Picture Productions International',
    inviterName: 'Erik Lundqvist',
    acceptUrl: 'https://allocate.at/invite/accept?token=REPLACE_ME',
    role: 'admin',
  }).html,
  'verifyEmail.html': verifyEmailEmail({
    verifyUrl: 'https://allocate.at/auth/action?mode=verifyEmail&oobCode=REPLACE_ME',
  }).html,
  'resetPassword.html': resetPasswordEmail({
    resetUrl: 'https://allocate.at/auth/action?mode=resetPassword&oobCode=REPLACE_ME',
  }).html,
  'changeEmail.html': changeEmailEmail({
    verifyUrl: 'https://allocate.at/auth/action?mode=verifyAndChangeEmail&oobCode=REPLACE_ME',
    newEmail: 'erik.lundqvist@nordfilm.se',
  }).html,
  'companyDeletionRequested.html': companyDeletionRequestedEmail({
    companyName: 'Nordfilm AB',
    requestedByName: 'Erik Lundqvist',
    requestedAtFormatted: '12 September 2026',
    scheduledForFormatted: '19 September 2026',
    scheduledForShort: '19 Sep',
    stopUrl: 'https://allocate.at/company/nordfilm/deletion/stop?token=REPLACE_ME',
    whatGoesSummary: '23 bookings, 14 pieces of equipment, access for all 6 members',
  }).html,
  'companyDeletionReminder.html': companyDeletionReminderEmail({
    companyName: 'Nordfilm AB',
    requestedByName: 'Erik Lundqvist',
    requestedAtFormatted: '12 September 2026',
    scheduledForFormatted: '19 September 2026',
    daysRemaining: 2,
    stopUrl: 'https://allocate.at/company/nordfilm/deletion/stop?token=REPLACE_ME',
  }).html,
  'companyDeletionCancelled.html': companyDeletionCancelledEmail({
    companyName: 'Nordfilm AB',
    cancelledByName: 'Sara Wikström',
    cancelledAtFormatted: '14 September 2026',
    scheduledForFormatted: '19 September 2026',
    openUrl: 'https://allocate.at/',
  }).html,
  'companyDeleted-window.html': companyDeletedEmail({
    companyName: 'Nordfilm AB',
    requestedByName: 'Erik Lundqvist',
    requestedAtFormatted: '12 September 2026',
    deletedAtFormatted: '19 September 2026',
    mode: 'window',
    accountAlsoDeleted: false,
    ctaUrl: 'https://allocate.at/company/new',
  }).html,
  'companyDeleted-window-account-also-deleted.html': companyDeletedEmail({
    companyName: 'Nordfilm AB',
    requestedByName: 'Erik Lundqvist',
    requestedAtFormatted: '12 September 2026',
    deletedAtFormatted: '19 September 2026',
    mode: 'window',
    accountAlsoDeleted: true,
    ctaUrl: 'https://allocate.at/signup',
  }).html,
  'companyDeleted-immediate.html': companyDeletedEmail({
    companyName: 'Solo Studio',
    requestedByName: 'Maria Öberg',
    requestedAtFormatted: '14 September 2026',
    deletedAtFormatted: '14 September 2026',
    mode: 'immediate',
    accountAlsoDeleted: false,
    ctaUrl: 'https://allocate.at/company/new',
  }).html,
  'companyDeleted-immediate-account-also-deleted.html': companyDeletedEmail({
    companyName: 'Solo Studio',
    requestedByName: 'Maria Öberg',
    requestedAtFormatted: '14 September 2026',
    deletedAtFormatted: '14 September 2026',
    mode: 'immediate',
    accountAlsoDeleted: true,
    ctaUrl: 'https://allocate.at/signup',
  }).html,
};

for (const [filename, html] of Object.entries(renders)) {
  writeFileSync(join(outDir, filename), html, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`wrote ${join(outDir, filename)}`);
}
