/**
 * Minimal Firestore test double for the automatic check-in/out tests (issue
 * #329) — documents addressed by path, just the surface `autoStatusEnqueue.ts`
 * and `autoStatusTask.ts` call: `collection().doc().get()`,
 * `.collection().where('status','==',x).get()`, `runTransaction` with
 * `tx.get`/`tx.update`. Same spirit as the FakeFirestore in
 * billingEmailReminder.test.ts.
 */
import type { Firestore } from 'firebase-admin/firestore';

export class FakeDb {
  docs = new Map<string, Record<string, unknown>>();
  /** Every update applied through a transaction, in order. */
  updates: Array<{ path: string; data: Record<string, unknown> }> = [];
  transactionRuns = 0;

  set(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, data);
  }

  private snap(path: string) {
    const data = this.docs.get(path);
    return { id: path.split('/').pop()!, exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  }

  private docRef(path: string) {
    return {
      path,
      get: async () => this.snap(path),
      collection: (name: string) => this.collectionRef(`${path}/${name}`),
    };
  }

  private collectionRef(path: string) {
    return {
      doc: (id: string) => this.docRef(`${path}/${id}`),
      where: (field: string, op: string, value: unknown) => {
        if (op !== '==') throw new Error(`unexpected operator ${op}`);
        return {
          get: async () => ({
            docs: [...this.docs.keys()]
              .filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
              .filter((k) => this.docs.get(k)![field] === value)
              .map((k) => this.snap(k)),
          }),
        };
      },
    };
  }

  collection(name: string) {
    return this.collectionRef(name);
  }

  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    this.transactionRuns++;
    const tx = {
      get: async (ref: { path: string }) => this.snap(ref.path),
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        this.updates.push({ path: ref.path, data });
        this.docs.set(ref.path, { ...this.docs.get(ref.path), ...data });
      },
    };
    return fn(tx);
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
