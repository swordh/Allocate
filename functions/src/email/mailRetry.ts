import { ResendSendError } from './send';

/**
 * Resend error names that are worth retrying — verified against
 * `node_modules/resend/dist/index.js`'s `RESEND_ERROR_CODES_BY_KEY` map,
 * not guessed:
 *
 *   rate_limit_exceeded      429  — we sent too fast, will succeed later
 *   application_error        500 — Resend's catch-all, ALSO what the SDK
 *                                   substitutes for a network-level failure
 *                                   (fetch rejected, non-JSON error body)
 *   internal_server_error    500 — Resend's own internal failure
 *
 * Everything else in that map (400/401/403/404/405/409/422) is caused by
 * something about the request itself — a bad address, a missing field, an
 * invalid API key — and will fail again identically on retry.
 */
const TRANSIENT_RESEND_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded',
  'application_error',
  'internal_server_error',
]);

export type MailErrorClass = 'transient' | 'permanent';

/**
 * Classifies a send failure as worth retrying (`transient`) or not
 * (`permanent`). Anything that isn't a `ResendSendError` — a bug in our own
 * rendering code, an unknown template key, a malformed mail doc — is treated
 * as permanent: retrying a `renderMail` throw five times just delays the
 * same crash, it never starts succeeding.
 */
export function classifyMailError(err: unknown): MailErrorClass {
  if (err instanceof ResendSendError) {
    return TRANSIENT_RESEND_CODES.has(err.code) ? 'transient' : 'permanent';
  }
  return 'permanent';
}

/** Mail gets marked `error` (no further retry) after this many attempts. */
export const MAX_MAIL_ATTEMPTS = 5;

const BASE_DELAY_MS = 60_000; // 1 minute
const MAX_DELAY_MS = 30 * 60_000; // 30 minutes

/**
 * Exponential backoff for the Nth failed attempt: 1, 2, 4, 8, ... minutes,
 * capped at 30 minutes. `attempts` is the count AFTER the failure that just
 * happened (1 on the first failure), so the first retry is scheduled ~1
 * minute out.
 */
export function computeBackoffMs(attempts: number): number {
  const delay = BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_DELAY_MS);
}
