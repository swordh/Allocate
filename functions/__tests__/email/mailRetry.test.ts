import { describe, it, expect } from 'vitest';
import { ResendSendError } from '../../src/email/send';
import { classifyMailError, computeBackoffMs, MAX_MAIL_ATTEMPTS } from '../../src/email/mailRetry';

describe('classifyMailError', () => {
  it.each(['rate_limit_exceeded', 'application_error', 'internal_server_error'])(
    'treats Resend %s as transient',
    (code) => {
      expect(classifyMailError(new ResendSendError(code, 'boom'))).toBe('transient');
    },
  );

  it.each([
    'missing_required_field',
    'invalid_idempotency_key',
    'invalid_idempotent_request',
    'concurrent_idempotent_requests',
    'invalid_access',
    'invalid_parameter',
    'invalid_region',
    'missing_api_key',
    'invalid_api_Key',
    'invalid_from_address',
    'validation_error',
    'not_found',
    'method_not_allowed',
  ])('treats Resend %s as permanent', (code) => {
    expect(classifyMailError(new ResendSendError(code, 'boom'))).toBe('permanent');
  });

  it('treats an unrecognized Resend error name as permanent (fail closed)', () => {
    expect(classifyMailError(new ResendSendError('some_future_code', 'boom'))).toBe('permanent');
  });

  it('treats a non-Resend error (e.g. a renderMail bug or unknown template) as permanent', () => {
    expect(classifyMailError(new Error('Unknown mail template: bogus'))).toBe('permanent');
  });

  it('treats a thrown non-Error value as permanent', () => {
    expect(classifyMailError('not even an Error')).toBe('permanent');
  });
});

describe('computeBackoffMs', () => {
  it('starts at 1 minute for the first attempt', () => {
    expect(computeBackoffMs(1)).toBe(60_000);
  });

  it('doubles for each subsequent attempt', () => {
    expect(computeBackoffMs(2)).toBe(120_000);
    expect(computeBackoffMs(3)).toBe(240_000);
    expect(computeBackoffMs(4)).toBe(480_000);
  });

  it('caps at 30 minutes and does not keep growing past it', () => {
    // 2^4 * 1min = 16min (attempt 5, uncapped) vs. 2^5 * 1min = 32min (attempt
    // 6, would exceed the cap) — the cap has to actually bind somewhere.
    expect(computeBackoffMs(5)).toBe(16 * 60_000);
    expect(computeBackoffMs(6)).toBe(30 * 60_000);
    expect(computeBackoffMs(10)).toBe(30 * 60_000);
  });

  it('treats attempts <= 0 the same as attempt 1 rather than going negative', () => {
    expect(computeBackoffMs(0)).toBe(60_000);
    expect(computeBackoffMs(-3)).toBe(60_000);
  });
});

describe('MAX_MAIL_ATTEMPTS', () => {
  it('is 5, matching the plan (five attempts before a mail is marked error)', () => {
    expect(MAX_MAIL_ATTEMPTS).toBe(5);
  });
});
