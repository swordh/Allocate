/**
 * `cleanupOneMember` (functions/src/company/memberCleanup.ts) — issue #398's
 * unguarded claims write. When a purged member's `activeCompanyId` is
 * repointed to a remaining membership, the role written into Custom Claims
 * used to be read straight off that membership doc (`next['role'] as
 * string`) with no allowlist at all. This pins that it now routes through
 * `toRole`: the removed `'viewer'` role, or any other invalid value, on the
 * remaining membership doc must come out as `crew` in the claims write (with
 * a warning logged), not be trusted verbatim.
 *
 * Also covers issue #294's ordering fix on the STRANDED branch (no
 * remaining membership): `hashUserIdForAudit` is called BEFORE
 * `userRef.set(pendingDeletion, ...)`, not after — see that call site's own
 * docblock for why. The two tests below pin exactly that: a missing
 * `AUDIT_LOG_HMAC_KEY` must leave NEITHER write behind, and a present one
 * must produce an audit row whose `userIdHash` is the exact expected HMAC.
 *
 * Minimal Firestore/Auth test doubles, in the same spirit as
 * `billingEmailReminder.test.ts` — `cleanupOneMember` takes its `db`
 * argument directly rather than importing `adminDb`, so there is no module
 * to mock around for Firestore. `firebase-admin/auth`'s `getAuth()` IS a
 * module-level import, so that one is mocked.
 */
import { createHmac } from 'crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { logger } from 'firebase-functions/v2';

const mockSetCustomUserClaims = vi.fn();
const mockRevokeRefreshTokens = vi.fn();

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    setCustomUserClaims: mockSetCustomUserClaims,
    revokeRefreshTokens: mockRevokeRefreshTokens,
  }),
}));

import { cleanupOneMember } from '../../src/company/memberCleanup';

const COMPANY_ID = 'company-purged';
const OTHER_COMPANY_ID = 'company-remaining';
const UID = 'uid-stranded-not';
const REQUEST_ID = 'req-1';

/** Just enough of the Firestore surface cleanupOneMember calls. */
function makeFakeDb(opts: { remainingRole: unknown }) {
  const membershipDeleteSpy = vi.fn().mockResolvedValue(undefined);
  const userSetSpy = vi.fn().mockResolvedValue(undefined);

  const remainingDoc = {
    ref: { path: `users/${UID}/memberships/${OTHER_COMPANY_ID}` },
    data: () => ({ companyId: OTHER_COMPANY_ID, role: opts.remainingRole }),
  };

  const db = {
    doc(path: string) {
      if (path === `users/${UID}/memberships/${COMPANY_ID}`) {
        return { delete: membershipDeleteSpy };
      }
      if (path === `users/${UID}`) {
        return {
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ activeCompanyId: COMPANY_ID }),
          }),
          set: userSetSpy,
        };
      }
      throw new Error(`unexpected db.doc(${path})`);
    },
    collection(path: string) {
      if (path === `users/${UID}/memberships`) {
        return { get: vi.fn().mockResolvedValue({ docs: [remainingDoc] }) };
      }
      throw new Error(`unexpected db.collection(${path})`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { db, membershipDeleteSpy, userSetSpy };
}

describe('cleanupOneMember — role coercion on the claims write (issue #398)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetCustomUserClaims.mockResolvedValue(undefined);
    mockRevokeRefreshTokens.mockResolvedValue(undefined);
  });

  it('coerces the removed legacy viewer role on the remaining membership to crew and warns', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db } = makeFakeDb({ remainingRole: 'viewer' });

    const outcome = await cleanupOneMember(db, COMPANY_ID, UID, REQUEST_ID);

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: OTHER_COMPANY_ID,
      role: 'crew',
    });
    expect(outcome.claimsUpdated).toBe(true);
    expect(outcome.accountStatus).toBe('kept');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('coerces an invalid role on the remaining membership to crew', async () => {
    const { db } = makeFakeDb({ remainingRole: 'owner' });

    await cleanupOneMember(db, COMPANY_ID, UID, REQUEST_ID);

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: OTHER_COMPANY_ID,
      role: 'crew',
    });
  });

  it('passes a valid admin role through unchanged', async () => {
    const { db } = makeFakeDb({ remainingRole: 'admin' });

    await cleanupOneMember(db, COMPANY_ID, UID, REQUEST_ID);

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith(UID, {
      activeCompanyId: OTHER_COMPANY_ID,
      role: 'admin',
    });
  });
});

// ── issue #294: hash-before-set ordering on the STRANDED branch ────────────

const STRANDED_UID = 'uid-stranded';

/** Same shape as `makeFakeDb` above, but with NO remaining membership docs —
 *  `remaining.length === 0`, which is what routes `cleanupOneMember` into
 *  its "stranded" branch (schedule `pendingDeletion`, write a
 *  `deletionAuditLog` row) instead of "kept". `userData` carries no
 *  `activeCompanyId` at all, so the claims-update branch above it is never
 *  entered — keeps these tests focused on the stranded branch alone. */
function makeStrandedFakeDb() {
  const membershipDeleteSpy = vi.fn().mockResolvedValue(undefined);
  const userSetSpy = vi.fn().mockResolvedValue(undefined);
  const auditAddSpy = vi.fn().mockResolvedValue(undefined);

  const db = {
    doc(path: string) {
      if (path === `users/${STRANDED_UID}/memberships/${COMPANY_ID}`) {
        return { delete: membershipDeleteSpy };
      }
      if (path === `users/${STRANDED_UID}`) {
        return {
          get: vi.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
          set: userSetSpy,
        };
      }
      throw new Error(`unexpected db.doc(${path})`);
    },
    collection(path: string) {
      if (path === `users/${STRANDED_UID}/memberships`) {
        return { get: vi.fn().mockResolvedValue({ docs: [] }) };
      }
      if (path === 'deletionAuditLog') {
        return { add: auditAddSpy };
      }
      throw new Error(`unexpected db.collection(${path})`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { db, membershipDeleteSpy, userSetSpy, auditAddSpy };
}

describe('cleanupOneMember — STRANDED branch, hash-before-set ordering (issue #294)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetCustomUserClaims.mockResolvedValue(undefined);
    mockRevokeRefreshTokens.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('AUDIT_LOG_HMAC_KEY missing: throws, writes NEITHER pendingDeletion NOR the audit row', async () => {
    vi.stubEnv('AUDIT_LOG_HMAC_KEY', '');
    const { db, userSetSpy, auditAddSpy } = makeStrandedFakeDb();

    await expect(cleanupOneMember(db, COMPANY_ID, STRANDED_UID, REQUEST_ID)).rejects.toThrow(
      'AUDIT_LOG_HMAC_KEY is not set',
    );

    // Neither the schedule nor the audit row was written — see this
    // branch's own docblock in memberCleanup.ts for why that invariant
    // matters: leaving the schedule written without the audit row would
    // make the idempotency guard above silently skip the audit write on
    // every future retry.
    expect(userSetSpy).not.toHaveBeenCalled();
    expect(auditAddSpy).not.toHaveBeenCalled();
  });

  it('happy path: writes a deletionAuditLog row whose userIdHash equals the exact expected HMAC', async () => {
    const testKey = 'test-audit-hmac-key-do-not-use-in-prod';
    vi.stubEnv('AUDIT_LOG_HMAC_KEY', testKey);
    const { db, userSetSpy, auditAddSpy } = makeStrandedFakeDb();

    const outcome = await cleanupOneMember(db, COMPANY_ID, STRANDED_UID, REQUEST_ID);

    expect(outcome.accountStatus).toBe('scheduled');
    expect(userSetSpy).toHaveBeenCalledOnce();
    expect(auditAddSpy).toHaveBeenCalledOnce();
    const row = auditAddSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.userIdHash).toBe(createHmac('sha256', testKey).update(STRANDED_UID).digest('hex'));
  });
});
