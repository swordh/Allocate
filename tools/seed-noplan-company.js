/**
 * Seed script: creates TWO companies on alpha for manually verifying GitHub
 * issue #350 — one for each state the old `app/(app)/layout.tsx` guard
 * blocked, because they are blocked by two DIFFERENT lines of the old code
 * and unblocked by two DIFFERENT paths through the fix
 * (`lib/subscriptionAccess.ts`'s `evaluateAppAccess`). Testing only one of
 * them proves less than it looks like it proves.
 *
 * ── THE TWO STATES, AND WHY BOTH ARE NEEDED ─────────────────────────────────
 *
 * 1. AUTO-TRIAL (`subscription` PRESENT, `status: 'trialing'`, `trialEnd:
 *    null`) — what `setupNewCompany` (actions/auth.ts:227) ACTUALLY writes
 *    for every new signup. `needsSubscription` (lib/subscriptionAccess.ts)
 *    only treats `trialing` as full access when `trialEnd !== null` — a real
 *    Stripe trial. The auto-trial's `trialEnd` is `null`, so a brand-new
 *    company that never chose a plan has `hasFullAccess === false` from the
 *    moment it's created. This is what issue #350's own repro steps hit
 *    ("nytt konto + företag, ingen plan vald → /settings/account studsar") —
 *    and it means the issue's stated root cause is misleading: the OLD code
 *    was
 *      if (!subscription) redirect('/subscribe')          // never reached
 *      ...
 *      const settingsOnly = ['past_due','canceled','incomplete'].includes(subStatus)
 *      if (!hasFullAccess) { if (!settingsOnly) redirect('/subscribe') }
 *    and `'trialing'` is not in `settingsOnlyStatuses`, so the repro actually
 *    went through the `else` branch on the SECOND check, never the `if
 *    (!subscription)` line the issue names as root cause. This state is
 *    reachable through the app's own signup UI, but is seeded here anyway
 *    so the test doesn't depend on a signup flow that sends real mail.
 *
 * 2. NO `subscription` FIELD AT ALL (`companyData?.subscription` reads
 *    `undefined`) — the literal state issue #350 names, and the one that
 *    hits `if (!subscription) redirect('/subscribe')` in the old code. No
 *    Stripe status reproduces it — `setupNewCompany` always writes SOME
 *    subscription map, so this can't happen through the app's own UI on
 *    current alpha. It's a launch-era-leftover / defensive-edge-case state,
 *    which is exactly why it needs a seed script rather than a status edit.
 *
 * Both are unblocked today by `evaluateAppAccess` treating the ROUTE
 * (`SETTINGS_ITEMS[].alwaysAvailable`), not the specific billing status, as
 * the source of truth — see that function's docblock in
 * lib/subscriptionAccess.ts. Seeding both states is what actually confirms
 * that fix, rather than confirming it only for the line the issue happened
 * to name.
 *
 * ── DOCUMENT SHAPES: DERIVED FROM ─────────────────────────────────────────
 * - Company doc fields, member doc shape, membership doc shape, `_meta`
 *   counters: `actions/auth.ts` (`setupNewCompany`) — the ONLY place a
 *   company document is created from scratch in this codebase.
 * - The auto-trial `subscription` map: `actions/auth.ts:227-234`
 *   (`setupNewCompany`'s `batch.set(companyRef, { subscription: {...} })`),
 *   copied verbatim.
 * - `PLAN_LIMITS.starter`: `lib/subscription.ts` — `{ equipment: 25, users:
 *   10 }`. Inlined below because this is a standalone REST script (same
 *   convention as the rest of `tools/`) and can't import a Next.js module.
 * - `preferences` defaults: `constants/company.ts` (`DEFAULT_COMPANY_PREFERENCES`).
 * - `stats` initial shape: `lib/companyStats.ts` (`INITIAL_COMPANY_STATS`),
 *   with `memberCount` set explicitly the way `setupNewCompany` does (not
 *   folded into the constant, which must stay an honest zero state).
 * - Membership doc for the two invited-style members (both crew): same
 *   `companies/{cid}/members/{uid}` and `users/{uid}/memberships/{cid}`
 *   shapes `functions/src/auth/acceptInvitation.ts` writes for an invitation
 *   accepted via the `/invite/{token}` link (as of issue #396, the only path
 *   that turns an invitation into a membership — `onUserCreate.ts` is a
 *   no-op) — identical shape (`MembershipDocument` in
 *   `functions/src/types.ts`) to the founder's, which is why one
 *   member-doc builder below covers all three roles in both companies.
 * - Custom Claims shape (`activeCompanyId`, `role`): `actions/auth.ts`
 *   (`setupNewCompany`'s `setCustomUserClaims` call) and
 *   `functions/src/auth/acceptInvitation.ts`'s equivalent call.
 * - `getVerifiedSession` requiring email verification before anything else:
 *   `lib/dal.ts` (`verifyAuthenticatedSession`) — `decoded['email_verified']
 *   === false` redirects to /verify-email BEFORE the company claim is even
 *   looked at, so an unverified seeded user would fail on the wrong thing.
 * - Expected redirect targets per role: `lib/subscriptionAccess.ts`
 *   (`evaluateAppAccess`) — admin without access → `/subscribe`; non-admin
 *   without access → `/settings/account`, never `/subscribe` (a crew
 *   member can't buy a plan, so sending her to a "choose a plan" page is a
 *   dead end); `SETTINGS_ITEMS` (`components/nav/nav-items.ts`) for which
 *   `/settings/*` tabs are `alwaysAvailable` and which roles can see them.
 *
 * ── WHAT IS DELIBERATELY *NOT* WRITTEN ──────────────────────────────────────
 * `setupNewCompany` also seeds `companies/{cid}/categories/*` (six default
 * categories). That's cosmetic for this test (#350 is a routing/access
 * question, not an equipment one) and is skipped here to keep the fixture
 * focused — nothing under test reads it.
 *
 * Run from repo root:
 *   node tools/seed-noplan-company.js
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

// ── Guard: alpha only ────────────────────────────────────────────────────────
// This script deliberately creates broken/edge-case-state companies. It
// must never run against prod or beta.

const ALPHA_PROJECT = 'allocate-alpha';

// ── Constants ─────────────────────────────────────────────────────────────────

const TEMP_PASSWORD = 'Allocate2026!';

// lib/subscription.ts PLAN_LIMITS.starter, inlined — see docblock above.
const STARTER_LIMITS = { equipment: 25, users: 10 };

const COMPANIES = [
  {
    key:         'nosub',
    name:        'Issue #350 No-Plan Test Co',
    // 'none'    → no `subscription` field at all (companyData?.subscription === undefined)
    // 'autotrial' → subscription present, status 'trialing', trialEnd null
    subscriptionMode: 'none',
    oldBlockingLine:  "`if (!subscription) redirect('/subscribe')` — the line issue #350 names as root cause",
    users: [
      { role: 'admin',  name: 'Claude350 Admin',  email: 'dev+claude350admin@allocate.at' },
      { role: 'crew',   name: 'Claude350 Crew',   email: 'dev+claude350crew@allocate.at' },
      { role: 'crew',   name: 'Claude350 Crew2',  email: 'dev+claude350crew2@allocate.at' },
    ],
  },
  {
    key:         'autotrial',
    name:        'Issue #350 Auto-Trial Test Co',
    subscriptionMode: 'autotrial',
    oldBlockingLine:  "the `else` branch of the old `settingsOnlyStatuses` whitelist check — 'trialing' was never in `['past_due','canceled','incomplete']`, which is what the issue's own repro steps actually hit",
    users: [
      { role: 'admin',  name: 'Claude350T Admin',  email: 'dev+claude350tadmin@allocate.at' },
      { role: 'crew',   name: 'Claude350T Crew',   email: 'dev+claude350tcrew@allocate.at' },
      { role: 'crew',   name: 'Claude350T Crew2',  email: 'dev+claude350tcrew2@allocate.at' },
    ],
  },
];

// ── Helpers (copied from tools/seed-apex-alpha.js — standalone scripts, no shared module) ──

function loadEnv() {
  const raw = fs.readFileSync(path.resolve(__dirname, '../.env.local'), 'utf8');
  const vars = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return vars;
}

async function getOAuthToken(serviceAccount) {
  // The firebase-tools.json cached user OAuth token expires; mint a fresh
  // token from the (already project-verified) service account instead.
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/datastore'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

function newId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let id = '';
  for (let i = 0; i < 20; i++) id += chars[bytes[i] % chars.length];
  return id;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

function httpReq(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = { Authorization: `Bearer ${token}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const httpPost = (url, t, body) => httpReq('POST', url, t, body);

async function commitBatch(token, project, writes) {
  const url   = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`;
  const CHUNK = 450;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const chunk = writes.slice(i, i + CHUNK);
    console.log(`  Committing ${chunk.length} writes (${i + 1}–${i + chunk.length} / ${writes.length})…`);
    const res = await httpPost(url, token, { writes: chunk });
    if (res.status !== 200) { console.error('Error:', JSON.stringify(res.body, null, 2)); throw new Error(`HTTP ${res.status}`); }
  }
}

// ── Firestore REST value helpers ───────────────────────────────────────────────

const str  = v      => ({ stringValue: v });
const nil  = ()     => ({ nullValue: 'NULL_VALUE' });
const ts   = v      => ({ timestampValue: v });
const bool = v      => ({ booleanValue: v });
const int  = v      => ({ integerValue: String(v) });
const arr  = values => ({ arrayValue: { values: values ?? [] } });
const map  = fields => ({ mapValue: { fields } });

function upsert(project, docPath, fields) {
  return { update: { name: `projects/${project}/databases/(default)/documents/${docPath}`, fields } };
}

// ── Find an existing company this script previously created ────────────────
// Idempotency: look up by `createdBy` == the admin's uid (mirrors how
// `setupNewCompany` itself scopes "does she already have a live company").

async function findExistingCompany(token, adminUid) {
  const url = `https://firestore.googleapis.com/v1/projects/${ALPHA_PROJECT}/databases/(default)/documents:runQuery`;
  const res = await httpPost(url, token, {
    structuredQuery: {
      from: [{ collectionId: 'companies' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'createdBy' },
          op: 'EQUAL',
          value: str(adminUid),
        },
      },
      limit: 1,
    },
  });
  const rows = Array.isArray(res.body) ? res.body : [];
  const hit = rows.find(r => r.document);
  if (!hit) return null;
  return hit.document.name.split('/').pop();
}

// ── Ensure the Auth users for one company exist, are verified, have the password ──

async function ensureUsers(auth, users) {
  const seeded = [];
  for (const u of users) {
    let uid;
    try {
      const existing = await auth.getUserByEmail(u.email);
      uid = existing.uid;
      console.log(`  ${u.role}: already exists (${uid})`);
      await auth.updateUser(uid, { displayName: u.name, password: TEMP_PASSWORD, emailVerified: true });
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      const created = await auth.createUser({
        email:          u.email,
        password:       TEMP_PASSWORD,
        displayName:    u.name,
        emailVerified:  true, // getVerifiedSession (lib/dal.ts) rejects unverified users first
      });
      uid = created.uid;
      console.log(`  ${u.role}: created (${uid})`);
    }
    seeded.push({ ...u, uid });
  }
  return seeded;
}

// ── Build the writes for one company + its three members ───────────────────

function buildCompanyWrites(company, seededUsers, admin, companyId, nowIso, writes) {
  // ── Company document ────────────────────────────────────────────────────
  // Mirrors actions/auth.ts `setupNewCompany`'s batch.set(companyRef, …).
  const companyFields = {
    name:             str(company.name),
    createdAt:        ts(nowIso),
    createdBy:        str(admin.uid),
    stripeCustomerId: str(''),
    hadTrial:         bool(false),
    preferences: map({
      bookingTimeSlotMinutes: int(15),
      autoCheckout:           bool(false),
      autoCheckin:            bool(false),
      timezone:               str('UTC'),
    }),
    stats: map({
      equipmentCount:     int(0),
      bookingsCreated:    int(0),
      bookingsCancelled:  int(0),
      lastBookingAt:      nil(),
      memberCount:        int(seededUsers.length),
      updatedAt:          ts(nowIso),
    }),
  };

  if (company.subscriptionMode === 'autotrial') {
    // Copied verbatim from actions/auth.ts:227-234 (setupNewCompany) — the
    // auto-trial every signup gets. trialEnd stays null: that's what marks
    // it as the non-billing auto-trial rather than a real Stripe trial (see
    // needsSubscription's docblock in lib/subscriptionAccess.ts).
    companyFields.subscription = map({
      status:            str('trialing'),
      plan:              str('starter'),
      limits: map({
        equipment: int(STARTER_LIMITS.equipment),
        users:     int(STARTER_LIMITS.users),
      }),
      currentPeriodEnd:  nil(),
      trialEnd:          nil(),
      cancelAtPeriodEnd: bool(false),
    });
  } else if (company.subscriptionMode !== 'none') {
    throw new Error(`Unknown subscriptionMode: ${company.subscriptionMode}`);
  }
  // else: subscriptionMode 'none' —
  // ****************************************************************
  // DO NOT ADD A `subscription` FIELD HERE. NOT `{}`, NOT `null`.
  // The field's total ABSENCE is the entire point of this company — it's
  // what companyData?.subscription reading `undefined` looks like for a
  // company that never started checkout. That's the exact state issue
  // #350 names. A well-meaning "fix" that adds an empty/null subscription
  // map defeats the fixture.
  // ****************************************************************

  writes.push(upsert(ALPHA_PROJECT, `companies/${companyId}`, companyFields));

  // ── _meta counters ─────────────────────────────────────────────────────
  // Same two counters setupNewCompany initializes in the same batch, so
  // createEquipment / the sole-admin guards never hit a missing-doc
  // fallback for this company.
  writes.push(upsert(ALPHA_PROJECT, `companies/${companyId}/_meta/equipmentCount`, {
    count:     int(0),
    updatedAt: ts(nowIso),
  }));
  writes.push(upsert(ALPHA_PROJECT, `companies/${companyId}/_meta/memberCounts`, {
    members:   int(seededUsers.length),
    admins:    int(seededUsers.filter(u => u.role === 'admin').length),
    updatedAt: ts(nowIso),
  }));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  // Guard 1: catches only an edited constant (e.g. someone changing
  // ALPHA_PROJECT above to point this script at another project). It does
  // NOT verify anything about the runtime environment — that's guard 2,
  // below, which is the one that actually matters.
  if (ALPHA_PROJECT !== 'allocate-alpha') {
    throw new Error(`Refusing to run: hard-coded target must be allocate-alpha, got ${ALPHA_PROJECT}`);
  }

  const env   = loadEnv();

  // Guard 2: verify the service account itself, before it's ever used.
  //
  // The Firestore writes below are safe regardless — every `upsert()` call
  // builds its document path from `ALPHA_PROJECT`, so they can only ever
  // target alpha's Firestore. Auth is different: `initializeApp({
  // credential, projectId })`'s `projectId` option does NOT redirect the
  // Auth SDK. `getAuth().createUser()` / `setCustomUserClaims()` operate on
  // whatever project the CREDENTIAL (the service account) belongs to,
  // full stop — `projectId` only affects the Firestore/other SDKs obtained
  // from this same app. If `.env.local` ever pointed at a prod service
  // account (stale file, copied env, someone debugging a prod issue), this
  // script would create six real users with a known shared password in
  // PRODUCTION Auth while writing the company docs safely to alpha
  // Firestore — a split-brain failure that's easy to miss because half of
  // it looks correct. So: parse the service account BEFORE calling
  // initializeApp, and refuse to proceed unless its own `project_id` says
  // allocate-alpha.
  const serviceAccount = JSON.parse(env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON);
  if (serviceAccount.project_id !== ALPHA_PROJECT) {
    throw new Error(
      `Refusing to run: FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON belongs to project ` +
      `"${serviceAccount.project_id}", expected "${ALPHA_PROJECT}". This script ` +
      `creates real Auth users with a known shared password — check .env.local.`
    );
  }

  const token = await getOAuthToken(serviceAccount);

  const { initializeApp, cert } = require('firebase-admin/app');
  const { getAuth }             = require('firebase-admin/auth');
  initializeApp({ credential: cert(serviceAccount), projectId: ALPHA_PROJECT });
  const auth = getAuth();

  console.log(`\nTarget project: ${ALPHA_PROJECT} (service account verified: ${serviceAccount.project_id})\n`);

  const writes  = [];
  const nowIso  = new Date().toISOString();
  const results = []; // { company, companyId, seededUsers }

  for (const company of COMPANIES) {
    console.log(`── ${company.key}: Auth users ───────────────────────────────────`);
    const seededUsers = await ensureUsers(auth, company.users);
    const admin = seededUsers.find(u => u.role === 'admin');

    console.log(`\n── ${company.key}: company (subscriptionMode: ${company.subscriptionMode}) ──`);
    let companyId = await findExistingCompany(token, admin.uid);
    if (companyId) {
      console.log(`  Reusing existing company (${companyId})`);
    } else {
      companyId = newId();
      console.log(`  Creating new company (${companyId})`);
      buildCompanyWrites(company, seededUsers, admin, companyId, nowIso, writes);
    }

    console.log(`\n── ${company.key}: members + user profiles + claims ────────────`);
    // Same companies/{cid}/members/{uid} and users/{uid}/memberships/{cid}
    // shapes for all three roles — setupNewCompany's companyMemberRef/
    // memberRef for the founder and functions/src/auth/acceptInvitation.ts's
    // memberRef/userMembershipRef for an accepted invite write the identical
    // shape (MembershipDocument in functions/src/types.ts).
    for (const u of seededUsers) {
      writes.push(upsert(ALPHA_PROJECT, `users/${u.uid}`, {
        name:            str(u.name),
        email:           str(u.email.toLowerCase()),
        activeCompanyId: str(companyId),
        createdAt:       ts(nowIso),
      }));

      writes.push(upsert(ALPHA_PROJECT, `users/${u.uid}/memberships/${companyId}`, {
        companyId: str(companyId),
        role:      str(u.role),
        joinedAt:  ts(nowIso),
      }));

      writes.push(upsert(ALPHA_PROJECT, `companies/${companyId}/members/${u.uid}`, {
        uid:       str(u.uid),
        name:      str(u.name),
        email:     str(u.email.toLowerCase()),
        role:      str(u.role),
        joinedAt:  ts(nowIso),
        companyId: str(companyId),
      }));

      // Custom Claims — same shape setupNewCompany and acceptInvitation both
      // set. ALLOWED from here: activeCompanyId, role. Never
      // subscription.* — those are Cloud-Function/webhook-only (see
      // actions/auth.ts comment).
      await auth.setCustomUserClaims(u.uid, { activeCompanyId: companyId, role: u.role });

      console.log(`  ${u.role.padEnd(6)} ${u.email}  (${u.uid})  role claim set`);
    }

    results.push({ company, companyId, seededUsers });
    console.log('');
  }

  console.log(`Total writes: ${writes.length}`);

  // ── Commit ───────────────────────────────────────────────────────────────

  if (writes.length > 0) {
    console.log('\n── Commit to alpha ─────────────────────────────────────────────');
    await commitBatch(token, ALPHA_PROJECT, writes);
  } else {
    console.log('\n── Nothing to commit — both companies and all members already existed ──');
  }

  // ── Test checklist ──────────────────────────────────────────────────────

  const baseUrl = 'https://allocate-alpha--allocate-alpha.europe-west4.hosted.app';

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ISSUE #350 — MANUAL VERIFICATION CHECKLIST (2 companies, 6 accounts)');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`\n  Password (all 6 accounts): ${TEMP_PASSWORD}`);
  console.log(`  Login URL: ${baseUrl}/login`);
  console.log('\n  Test BOTH companies. They are blocked by two different lines of');
  console.log("  the old code and are the reason issue #350's stated root cause");
  console.log('  (`if (!subscription)`) is not the branch its own repro steps hit —');
  console.log('  see this script\'s header docblock for the full explanation.');
  console.log('\n  Rule for every state below: admin without access → /subscribe;');
  console.log('  crew without access → /settings/account (never /subscribe —');
  console.log('  a non-admin cannot buy a plan). That difference is itself a test case.');

  for (const { company, companyId, seededUsers } of results) {
    console.log('\n  ────────────────────────────────────────────────────────────────');
    console.log(`  COMPANY: ${company.name}`);
    console.log(`  Company ID: ${companyId}`);
    console.log(`  State: ${company.subscriptionMode === 'none'
      ? 'subscription field ABSENT (companyData?.subscription === undefined)'
      : "subscription PRESENT, status 'trialing', trialEnd null (auto-trial)"}`);
    console.log(`  Old code line this state was blocked by: ${company.oldBlockingLine}`);

    for (const u of seededUsers) {
      console.log(`\n  ── ${u.role.padEnd(6)} ── ${u.email} ──`);
      console.log(`    ${baseUrl}/settings/account       → allowed (Delete Account, Export data)`);
      if (u.role === 'admin') {
        console.log(`    ${baseUrl}/settings/subscription  → allowed (admin-only, alwaysAvailable)`);
        console.log(`    ${baseUrl}/settings/company       → allowed (admin-only, alwaysAvailable)`);
        console.log(`    ${baseUrl}/settings/team          → redirect → /subscribe (not alwaysAvailable)`);
        console.log(`    ${baseUrl}/bookings                → redirect → /subscribe`);
        console.log(`    ${baseUrl}/equipment                → redirect → /subscribe`);
      } else {
        console.log(`    ${baseUrl}/settings/subscription  → redirect → /settings/account (admin-only tab)`);
        console.log(`    ${baseUrl}/settings/company       → redirect → /settings/account (admin-only tab)`);
        console.log(`    ${baseUrl}/bookings                → redirect → /settings/account (non-admin never sent to /subscribe)`);
        console.log(`    ${baseUrl}/equipment                → redirect → /settings/account`);
      }
    }
  }

  console.log('\n  ────────────────────────────────────────────────────────────────');
  console.log('  Key assertion for #350 itself: in BOTH companies and for EVERY');
  console.log('  role, /settings/account is directly reachable and Delete Account /');
  console.log('  Export my data work — that is the GDPR Art. 17/20 path the bug');
  console.log('  blocked, and it must hold regardless of which of the two states');
  console.log('  the company is in.');
  console.log('\n══════════════════════════════════════════════════════════════════\n');
}

run().catch(err => { console.error('\nFatal:', err.message || err); process.exit(1); });
