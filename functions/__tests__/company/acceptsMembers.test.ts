/**
 * `blockMemberWrite` (functions/src/company/acceptsMembers.ts) — the shared
 * guard behind `acceptInvitationByToken` and `onUserCreate` that stops a new
 * member from being written into a company that's on its way out.
 *
 * Issue #331/#335 added a THIRD reachable `deletion.state` on the mirror:
 * `'failed'` (previously only `'requested'`/`'executing'` were ever mirrored
 * — see `applyFailedTransition` in failDeletion.ts). This file's job is to
 * make sure the message a blocked signup/invite-accept sees matches reality
 * for all three: only `'requested'` still has a deletion left to stop.
 */
import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { blockMemberWrite } from '../../src/company/acceptsMembers';

function fakeSnap(exists: boolean, data?: Record<string, unknown>): DocumentSnapshot {
  return {
    exists,
    data: () => data,
  } as unknown as DocumentSnapshot;
}

describe('blockMemberWrite', () => {
  it('allows the write when the company exists and has no deletion field', () => {
    expect(blockMemberWrite(fakeSnap(true, { name: 'Acme' }))).toBeNull();
  });

  it('blocks with not-found when the company document is gone', () => {
    const result = blockMemberWrite(fakeSnap(false));
    expect(result).toEqual({ code: 'not-found', message: 'That company no longer exists.' });
  });

  it("state 'requested': tells the caller a deletion can still be stopped", () => {
    const result = blockMemberWrite(fakeSnap(true, { deletion: { state: 'requested' } }));
    expect(result?.code).toBe('deleting');
    expect(result?.message).toMatch(/stop the deletion first/i);
  });

  it("state 'executing': does NOT claim the deletion can still be stopped", () => {
    const result = blockMemberWrite(fakeSnap(true, { deletion: { state: 'executing' } }));
    expect(result?.code).toBe('deleting');
    expect(result?.message).not.toMatch(/stop the deletion/i);
    expect(result?.message).toBe('This company is being deleted and is not accepting new members.');
  });

  it("state 'failed' (issue #331/#335 — the mirror can now carry this): does NOT claim the deletion can still be stopped", () => {
    const result = blockMemberWrite(fakeSnap(true, { deletion: { state: 'failed' } }));
    expect(result?.code).toBe('deleting');
    expect(result?.message).not.toMatch(/stop the deletion/i);
    expect(result?.message).toBe('This company is being deleted and is not accepting new members.');
  });
});
