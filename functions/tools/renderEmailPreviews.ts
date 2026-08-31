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
};

for (const [filename, html] of Object.entries(renders)) {
  writeFileSync(join(outDir, filename), html, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`wrote ${join(outDir, filename)}`);
}
