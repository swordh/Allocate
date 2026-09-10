/**
 * Backfill: recompute the derived stats map on every company document.
 *
 * Writes companies/{id}.stats and companies/{id}/_meta/equipmentCount from the
 * actual subcollection contents, as absolute values. Both land in one batch per
 * company, so a run can never leave the counter and the mirror disagreeing.
 *
 * RUN ORDER MATTERS. The stats writers must already be deployed to the target
 * environment. FieldValue.increment treats a missing field as 0, so deploying
 * writers first only means values start low and this recompute subsumes them.
 * Running this first would silently lose every write in the gap.
 *
 * Per environment: promote and deploy -> --yes -> --verify -> only then ship
 * anything that reads these fields.
 *
 * Usage, from the repo root:
 *   node tools/backfill_company_stats.js --sa=/path/to/key.json            # dry run
 *   node tools/backfill_company_stats.js --sa=/path/to/key.json --yes      # apply
 *   node tools/backfill_company_stats.js --sa=/path/to/key.json --verify   # check only
 *
 * Without --sa it falls back to FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON in
 * .env.local, which only ever points at one project — pass --sa when running
 * against beta or prod.
 *
 * --verify exits non-zero when anything has drifted. Nothing is written unless
 * --yes is passed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = flag('yes');
const VERIFY = flag('verify');
const ONLY_COMPANY = value('company');
const SA_PATH = value('sa');
const CONCURRENCY = 5;
const PAGE_SIZE = 200;

// ── Credentials ──────────────────────────────────────────────────────────────

function loadServiceAccount() {
  if (SA_PATH) {
    const resolved = path.resolve(SA_PATH);
    if (!fs.existsSync(resolved)) {
      console.error(`ERROR: service account file not found: ${resolved}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }

  const envPath = path.resolve(__dirname, '../.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('ERROR: no --sa given and .env.local not found.');
    process.exit(1);
  }

  const vars = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const raw = vars['FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON'];
  if (!raw) {
    console.error('ERROR: FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON not found in .env.local');
    process.exit(1);
  }
  return JSON.parse(raw);
}

const serviceAccount = loadServiceAccount();

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Truth queries ────────────────────────────────────────────────────────────

async function computeStats(companyId) {
  const company = db.collection('companies').doc(companyId);

  const [equipment, bookings, cancelled, lastBooking] = await Promise.all([
    company.collection('equipment').where('active', '==', true).count().get(),
    company.collection('bookings').count().get(),
    company.collection('bookings').where('status', '==', 'cancelled').count().get(),
    company.collection('bookings').orderBy('createdAt', 'desc').limit(1).get(),
  ]);

  return {
    equipmentCount: equipment.data().count,
    bookingsCreated: bookings.data().count,
    bookingsCancelled: cancelled.data().count,
    lastBookingAt: lastBooking.empty ? null : lastBooking.docs[0].get('createdAt'),
  };
}

async function readStored(companyId) {
  const company = db.collection('companies').doc(companyId);

  const [companySnap, counterSnap] = await Promise.all([
    company.get(),
    company.collection('_meta').doc('equipmentCount').get(),
  ]);

  const stats = companySnap.get('stats') || {};
  return {
    stats: {
      equipmentCount: stats.equipmentCount ?? null,
      bookingsCreated: stats.bookingsCreated ?? null,
      bookingsCancelled: stats.bookingsCancelled ?? null,
      lastBookingAt: stats.lastBookingAt ?? null,
    },
    counter: counterSnap.exists ? counterSnap.get('count') : null,
    name: companySnap.get('name') || '(unnamed)',
  };
}

// ── Comparison ───────────────────────────────────────────────────────────────

const ts = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v);

function diff(stored, truth) {
  const out = [];
  for (const key of ['equipmentCount', 'bookingsCreated', 'bookingsCancelled']) {
    if (stored.stats[key] !== truth[key]) {
      out.push(`${key}: ${stored.stats[key] ?? '—'} → ${truth[key]}`);
    }
  }
  if (ts(stored.stats.lastBookingAt) !== ts(truth.lastBookingAt)) {
    out.push(`lastBookingAt: ${ts(stored.stats.lastBookingAt) ?? '—'} → ${ts(truth.lastBookingAt) ?? 'null'}`);
  }
  // The counter is authoritative for plan limits, so a mismatch here is more
  // serious than a stale mirror — call it out separately.
  if (stored.counter !== truth.equipmentCount) {
    out.push(`_meta counter: ${stored.counter ?? 'MISSING'} → ${truth.equipmentCount}`);
  }
  return out;
}

// ── Write ────────────────────────────────────────────────────────────────────

async function write(companyId, truth) {
  const company = db.collection('companies').doc(companyId);
  const batch = db.batch();

  // Both in one batch. This is the property that makes the counter and the
  // mirror incapable of disagreeing after a run.
  batch.set(
    company,
    {
      stats: {
        equipmentCount: truth.equipmentCount,
        bookingsCreated: truth.bookingsCreated,
        bookingsCancelled: truth.bookingsCancelled,
        // Explicit null, never omitted: Firestore excludes documents lacking a
        // field from inequality queries, so an omitted value would make the
        // company invisible to the "No bookings 30 d" segment.
        lastBookingAt: truth.lastBookingAt ?? null,
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  );

  batch.set(
    company.collection('_meta').doc('equipmentCount'),
    { count: truth.equipmentCount, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  await batch.commit();
}

// ── Enumeration ──────────────────────────────────────────────────────────────

async function* companyIds() {
  if (ONLY_COMPANY) {
    yield ONLY_COMPANY;
    return;
  }
  let cursor = null;
  for (;;) {
    let q = db.collection('companies').select().orderBy('__name__').limit(PAGE_SIZE);
    // Pass the snapshot itself, not the id — with __name__ ordering Firestore
    // expects a reference, and a bare id string silently paginates wrong.
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc.id;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

async function* chunks(iterable, size) {
  const out = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length === size) {
      yield out.splice(0, size);
    }
  }
  if (out.length) yield out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const projectId = serviceAccount.project_id;
  const mode = APPLY ? 'APPLY (writes)' : VERIFY ? 'VERIFY (read-only)' : 'DRY RUN (read-only)';

  console.log('');
  console.log(`  Project : ${projectId}`);
  console.log(`  Mode    : ${mode}`);
  if (ONLY_COMPANY) console.log(`  Company : ${ONLY_COMPANY}`);
  console.log('');

  let total = 0;
  let drifted = 0;
  let written = 0;
  const warnings = [];

  for await (const batchOfIds of chunks(companyIds(), CONCURRENCY)) {
    await Promise.all(
      batchOfIds.map(async (id) => {
        total += 1;
        const [truth, stored] = await Promise.all([computeStats(id), readStored(id)]);
        const changes = diff(stored, truth);

        // orderBy silently drops documents missing the ordered field, so a
        // company with bookings but no lastBookingAt means booking docs exist
        // without createdAt — worth knowing about, not worth failing on.
        if (truth.bookingsCreated > 0 && truth.lastBookingAt === null) {
          warnings.push(`${id} (${stored.name}): ${truth.bookingsCreated} bookings but none carry createdAt`);
        }

        if (changes.length === 0) {
          console.log(`  ok    ${id}  ${stored.name}`);
          return;
        }

        drifted += 1;
        console.log(`  DRIFT ${id}  ${stored.name}`);
        for (const c of changes) console.log(`          ${c}`);

        if (APPLY) {
          await write(id, truth);
          written += 1;
        }
      }),
    );
  }

  console.log('');
  const noun = total === 1 ? 'company' : 'companies';
  console.log(`  ${total} ${noun}, ${drifted} with drift${APPLY ? `, ${written} written` : ''}`);

  if (warnings.length) {
    console.log('');
    console.log('  Warnings:');
    for (const w of warnings) console.log(`    ${w}`);
  }

  if (!APPLY && drifted > 0) {
    console.log('');
    console.log(VERIFY ? '  Verification FAILED — drift found.' : '  Re-run with --yes to apply.');
  }
  console.log('');

  if (VERIFY && drifted > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
