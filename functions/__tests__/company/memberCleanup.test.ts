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
 * Minimal Firestore/Auth test doubles, in the same spirit as
 * `billingEmailReminder.test.ts` — `cleanupOneMember` takes its `db`
 * argument directly rather than importing `adminDb`, so there is no module
 * to mock around for Firestore. `firebase-admin/auth`'s `getAuth()` IS a
 * module-level import, so that one is mocked.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
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
