/**
 * PII masking helpers for one-off admin scripts under tools/.
 *
 * Pure functions, no dependencies, no Firebase imports — kept in their own
 * module specifically so they can be unit-tested (with plain `node -e` +
 * `assert`) without pulling in `firebase-admin/app`'s `initializeApp`, which
 * tools/cleanup_orphan_members.js runs at module load time.
 */

'use strict';

/**
 * Shortens a Firestore document id (uid) to an 8-character prefix, matching
 * the format actions/account.ts already uses for the same tradeoff
 * (`uid.slice(0, 8) + '...'`) — enough to spot a duplicate or cross-reference
 * against a support ticket, not enough to identify a person on its own.
 * `null`/`undefined`/empty string → '—'.
 */
function maskId(id) {
  if (!id) return '—';
  return `${String(id).slice(0, 8)}...`;
}

/**
 * Masks an email address as `j***@b***.se`: first character of the local
 * part + '***', '@', first character of the first domain label + '***',
 * then the TLD (last domain label) kept in clear text. Splits on the LAST
 * '@' (a local part may itself contain '@' only inside quotes, which this
 * script never sees in practice, but splitting on the last one is still the
 * correct half to treat as the domain).
 *
 * No '@' at all → '***' (can't tell local part from domain, so no partial
 * reveal). Domain with no '.' → just the first-label mask, no TLD to keep
 * (`b***`). `null`/undefined/empty → '—'.
 */
function maskEmail(email) {
  if (!email) return '—';
  const str = String(email);
  const at = str.lastIndexOf('@');
  if (at === -1) return '***';

  const local = str.slice(0, at);
  const domain = str.slice(at + 1);

  const localMask = `${local.charAt(0)}***`;
  if (!domain) return `${localMask}@***`;

  const dot = domain.lastIndexOf('.');
  if (dot === -1) return `${localMask}@${domain.charAt(0)}***`;

  const firstLabel = domain.slice(0, dot);
  const firstSubLabel = firstLabel.split('.')[0];
  const tld = domain.slice(dot + 1);
  return `${localMask}@${firstSubLabel.charAt(0)}***.${tld}`;
}

/**
 * Masks a person's name as `Anna H.`: first word kept in clear text, last
 * word reduced to its initial. A single-word name is returned as-is (there
 * is no "last word" to mask separately). Tolerates repeated/leading/
 * trailing whitespace. `null`/undefined/empty/whitespace-only → '—'.
 */
function maskName(name) {
  if (!name) return '—';
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0];
  const first = words[0];
  const lastInitial = words[words.length - 1].charAt(0);
  return `${first} ${lastInitial}.`;
}

module.exports = { maskId, maskEmail, maskName };
