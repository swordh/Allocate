/**
 * `runBillingEmailReminder` (fix/stripe-anonymise-billing-contact) — the
 * weekly sweep that chases `CompanyBilling.emailMissingSince` (see
 * types/company.ts) until an admin sets a new billing email, the
 * subscription stops needing one, or the company itself is gone.
 *
 * Exported as a plain function of `(db, stripe, now)` (same shape as
 * `runStrandedAccountSweep`/`runCompanyDeletionSweep`), so these tests build
 * minimal Firestore/Stripe test doubles directly rather than going through
 * `adminDb` mocking — there is no module-level Firestore import to mock
 * around.
 */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';

// `billingEmailReminder.ts` also exports the `onSchedule`-wrapped
// `billingEmailReminder` Cloud Function alongside the plain
// `runBillingEmailReminder` this file actually exercises — importing the
// module at all therefore calls `onSchedule(...)` and `defineSecret(...)` at
// load time. Both 'firebase-functions/v2/scheduler' and
// 'firebase-functions/params' are aliased to stubs in vitest.config.ts (see
// __tests__/__mocks__/firebase-functions-v2-scheduler.ts's docblock for why
// this has to be a config-level alias rather than a per-test `vi.mock`).
import { runBillingEmailReminder } from '../../src/company/billingEmailReminder';

// ── Minimal Firestore test double ───────────────────────────────────────────
//
// Just enough of the Admin SDK surface `billingEmailReminder.ts` actually
// calls: `collection(path).where(...).get()`, `doc(path).get()/.update()`,
// and `batch().set()/.update()/.commit()`. Deliberately not the root
// __tests__/helpers/firestore.ts helpers — those are built around mocking
// `adminDb` as an import, which this module never does.

interface FakeDoc {
  id: string;
  data: Record<string, unknown> | null;
}

class FakeFirestore {
  companies = new Map<string, Record<string, unknown> | null>();
  members = new Map<string, Array<{ id: string; data: Record<string, unknown> }>>();
  updates: Array<{ path: string; data: Record<string, unknown> }> = [];
  mailDocs: Array<Record<string, unknown>> = [];
  /**
   * Company ids whose `companies/{id}/members` query should throw instead of
   * resolving — for the "reaches the OUTER per-company catch" test. This is
   * a failure `processCompany` itself does NOT try/catch (only the Stripe
   * `customers.retrieve` call is), so it's exactly the shape needed to prove
   * `runBillingEmailReminder`'s own per-company try/catch (not
   * `processCompany`'s inner one) is what counts it as `failed` and keeps
   * the sweep going for the rest.
   */
  throwOnMembersQuery = new Set<string>();
  private mailCounter = 0;

  collection(path: string) {
    if (path === 'companies') {
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => {
            if (field !== 'billing.emailMissingSince') throw new Error(`unexpected filter field: ${field}`);
            const docs: FakeDoc[] = [];
            for (const [id, data] of this.companies) {
              const billing = data?.['billing'] as { emailMissingSince?: string } | undefined;
              if (billing?.emailMissingSince && billing.emailMissingSince > (value as string)) {
                docs.push({ id, data });
              }
            }
            return { docs };
          },
        }),
      };
    }

    const membersMatch = path.match(/^companies\/([^/]+)\/members$/);
    if (membersMatch) {
      const companyId = membersMatch[1]!;
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => {
            if (this.throwOnMembersQuery.has(companyId)) {
              throw new Error(`Simulated Firestore failure querying ${path}`);
            }
            const all = this.members.get(companyId) ?? [];
            const filtered = field === 'role' ? all.filter((m) => m.data['role'] === value) : all;
            return { docs: filtered.map((m) => ({ id: m.id, data: () => m.data })) };
          },
        }),
      };
    }

    if (path === 'mail') {
      return {
        doc: () => {
          const id = `auto-${++this.mailCounter}`;
          return {
            id,
            set: (data: Record<string, unknown>) => {
              this.mailDocs.push({ id, ...data });
            },
          };
        },
      };
    }

    throw new Error(`FakeFirestore.collection: unhandled path ${path}`);
  }

  doc(path: string) {
    const match = path.match(/^companies\/([^/]+)$/);
    if (!match) throw new Error(`FakeFirestore.doc: unhandled path ${path}`);
    const companyId = match[1]!;
    return {
      get: async () => {
        const data = this.companies.get(companyId) ?? null;
        return { exists: data !== null, data: () => data ?? undefined };
      },
      update: async (data: Record<string, unknown>) => {
        this.updates.push({ path, data });
        const current = this.companies.get(companyId);
        if (!current) return;
        if ('billing' in data && (data['billing'] as unknown) === DELETE_SENTINEL) {
          const next = { ...current };
          delete next['billing'];
          this.companies.set(companyId, next);
          return;
        }
        // Dotted-path merge — only `billing.lastReminderAt` is ever written this way.
        const next = { ...current };
        for (const [key, value] of Object.entries(data)) {
          if (key.includes('.')) {
            const [top, sub] = key.split('.') as [string, string];
            next[top] = { ...(next[top] as Record<string, unknown> | undefined), [sub]: value };
          } else {
            next[key] = value;
          }
        }
        this.companies.set(companyId, next);
      },
    };
  }

  batch() {
    const ops: Array<() => void> = [];
    return {
      set: (ref: { set: (data: Record<string, unknown>) => void }, data: Record<string, unknown>) => {
        ops.push(() => ref.set(data));
      },
      update: (ref: { update: (data: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) => {
        ops.push(() => void ref.update(data));
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
  }
}

// `FieldValue.delete()` sentinel — the real module imports the real
// `firebase-admin/firestore` FieldValue, so this fake just needs to
// recognise whatever THAT returns.
const DELETE_SENTINEL: unknown = FieldValue.delete();

function makeStripe(overrides: Partial<Stripe['customers']> = {}): Stripe {
  return {
    customers: {
      retrieve: vi.fn(),
      ...overrides,
    },
  } as unknown as Stripe;
}

const NOW = new Date('2026-09-23T09:00:00.000Z');
const SIX_DAYS_AGO = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000 - 1000).toISOString();
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

describe('runBillingEmailReminder', () => {
  it('sends a reminder when the last one was more than 6 days ago', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    db.members.set('company-A', [{ id: 'm1', data: { role: 'admin', email: 'admin@example.com' } }]);
    const stripe = makeStripe({
      retrieve: vi.fn().mockResolvedValue({ deleted: false, email: null }),
    });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 1, cleared: 0, skipped: 0, failed: 0 });
    expect(db.mailDocs).toHaveLength(1);
    expect(db.mailDocs[0]).toMatchObject({
      to: 'admin@example.com',
      template: 'billingEmailMissing',
      companyId: 'company-A',
      data: { companyName: 'Nordfilm AB', isReminder: true },
    });
    const company = db.companies.get('company-A')!;
    expect((company['billing'] as { lastReminderAt: string }).lastReminderAt).toBe(NOW.toISOString());
  });

  it('skips (no mail, flag untouched) when the last reminder was less than 6 days ago', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: TWO_DAYS_AGO },
    });
    db.members.set('company-A', [{ id: 'm1', data: { role: 'admin', email: 'admin@example.com' } }]);
    const stripe = makeStripe({ retrieve: vi.fn().mockResolvedValue({ deleted: false, email: null }) });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 0, skipped: 1, failed: 0 });
    expect(db.mailDocs).toHaveLength(0);
    expect(db.companies.get('company-A')!['billing']).toMatchObject({ lastReminderAt: TWO_DAYS_AGO });
  });

  it('clears the flag once the Stripe customer has an email again', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    const stripe = makeStripe({
      retrieve: vi.fn().mockResolvedValue({ deleted: false, email: 'new-billing@example.com' }),
    });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 1, skipped: 0, failed: 0 });
    expect(db.companies.get('company-A')!['billing']).toBeUndefined();
    expect(db.mailDocs).toHaveLength(0);
  });

  it('clears the flag when the Stripe customer is deleted', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    const stripe = makeStripe({ retrieve: vi.fn().mockResolvedValue({ deleted: true }) });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 1, skipped: 0, failed: 0 });
    expect(db.companies.get('company-A')!['billing']).toBeUndefined();
  });

  it('clears the flag when the subscription is canceled (no longer worth chasing)', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'canceled' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    const stripe = makeStripe({ retrieve: vi.fn() });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 1, skipped: 0, failed: 0 });
    // Subscription already settled the outcome — Stripe was never consulted.
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("clears the flag when the company's deletion is state 'requested' (window/immediate, still counting down)", async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      deletion: { state: 'requested' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    const stripe = makeStripe({ retrieve: vi.fn() });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 1, skipped: 0, failed: 0 });
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("clears the flag when the company's deletion is state 'executing' (the purge has claimed it)", async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      deletion: { state: 'executing' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    const stripe = makeStripe({ retrieve: vi.fn() });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 1, skipped: 0, failed: 0 });
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("does NOT clear the flag (and keeps reminding) when the company's deletion is state 'failed' — the purge stalled, the company is still here", async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      deletion: { state: 'failed' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    db.members.set('company-A', [{ id: 'm1', data: { role: 'admin', email: 'admin@example.com' } }]);
    const stripe = makeStripe({ retrieve: vi.fn().mockResolvedValue({ deleted: false, email: null }) });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 1, cleared: 0, skipped: 0, failed: 0 });
    expect(db.companies.get('company-A')!['billing']).toBeDefined();
    expect(db.mailDocs).toHaveLength(1);
  });

  it('does not send mail (and does not clear the flag) when no admin has an email', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Nordfilm AB',
      stripeCustomerId: 'cus_1',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    db.members.set('company-A', [{ id: 'm1', data: { role: 'admin' } }]); // no email field
    const stripe = makeStripe({ retrieve: vi.fn().mockResolvedValue({ deleted: false, email: null }) });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 0, cleared: 0, skipped: 1, failed: 0 });
    expect(db.mailDocs).toHaveLength(0);
    expect(db.companies.get('company-A')!['billing']).toBeDefined();
  });

  it('one company failing does not stop the sweep from processing the others', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Broken AB',
      stripeCustomerId: 'cus_broken',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    db.companies.set('company-B', {
      name: 'Fine AB',
      stripeCustomerId: 'cus_fine',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    db.members.set('company-B', [{ id: 'm1', data: { role: 'admin', email: 'admin-b@example.com' } }]);

    const retrieve = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'cus_broken') throw new Error('Simulated Stripe outage');
      return { deleted: false, email: null };
    });
    const stripe = makeStripe({ retrieve });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    // company-A's retrieve throws — caught inside processCompany itself
    // (best-effort, non-fatal), so it comes back as 'skipped', not 'failed'.
    // The real guarantee this test is for is that company-B still gets
    // processed and mailed regardless.
    expect(result.sent).toBe(1);
    expect(db.mailDocs).toHaveLength(1);
    expect(db.mailDocs[0]).toMatchObject({ to: 'admin-b@example.com', companyId: 'company-B' });
  });

  it('a failure that reaches the OUTER per-company catch (e.g. the members query throwing) is counted as `failed`, and the next company is still processed', async () => {
    const db = new FakeFirestore();
    db.companies.set('company-A', {
      name: 'Broken AB',
      stripeCustomerId: 'cus_broken',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    db.companies.set('company-B', {
      name: 'Fine AB',
      stripeCustomerId: 'cus_fine',
      subscription: { status: 'active' },
      billing: { emailMissingSince: '2026-09-01T00:00:00.000Z', lastReminderAt: SIX_DAYS_AGO },
    });
    // company-A's Stripe retrieve succeeds (no email, no deleted flag) so
    // `processCompany` reaches its own admins query and THAT throws — a
    // failure outside processCompany's one internal try/catch, so it must
    // propagate up to runBillingEmailReminder's own per-company try/catch.
    db.throwOnMembersQuery.add('company-A');
    db.members.set('company-B', [{ id: 'm1', data: { role: 'admin', email: 'admin-b@example.com' } }]);

    const stripe = makeStripe({ retrieve: vi.fn().mockResolvedValue({ deleted: false, email: null }) });

    const result = await runBillingEmailReminder(db as never, stripe, NOW);

    expect(result).toEqual({ sent: 1, cleared: 0, skipped: 0, failed: 1 });
    expect(db.mailDocs).toHaveLength(1);
    expect(db.mailDocs[0]).toMatchObject({ to: 'admin-b@example.com', companyId: 'company-B' });
    // company-A's billing flag is untouched — a Firestore failure must not
    // look like the problem resolved itself.
    expect(db.companies.get('company-A')!['billing']).toBeDefined();
  });
});
