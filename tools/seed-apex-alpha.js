/**
 * Seed script: replicates MrTest (prod) → Apex (alpha).
 *
 * - Reads current equipment + units + bookings from prod via REST API
 * - Creates the 5 test users in alpha Firebase Auth
 * - Writes everything to alpha Apex, translating all IDs correctly
 *
 * Run from repo root:
 *   node tools/seed-apex-alpha.js
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────

const ALPHA_PROJECT  = 'allocate-alpha';
const PROD_PROJECT   = 'allocate-e0735';
const ALPHA_COMPANY  = 'gjF7QOo5kZ6ESfDFPg9n';
const PROD_COMPANY   = 'yd8eIat7BZcJZs8eiw76';
const TEMP_PASSWORD  = 'Allocate2026!';

// Known prod UIDs for the 5 test users
const PROD_USERS = [
  { prodUid: 'vXsxHo3PYLhjswsd9owCJT9zYcE3', name: 'Alexander Miller', email: 'swordh+alexander@gmail.com' },
  { prodUid: 'ODUKzVDNo8euSZ9LXuj5dtNpW9H2', name: 'Lucas Silva',       email: 'swordh+lucas@gmail.com' },
  { prodUid: 'nLnZTw0TJcSz1K0y1ReCOqqDgq83', name: 'Sebastian Novak',   email: 'swordh+sebastian@gmail.com' },
  { prodUid: 'CQetb7hXLTfJb53JaJiwohIU49M2', name: 'Sofia Rossi',        email: 'swordh+sofia@gmail.com' },
  { prodUid: 'SCkb6KM4XlOxRGnrSu9Yv9L4V8n2', name: 'Maya Andersson',     email: 'swordh+maya@gmail.com' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function getOAuthToken() {
  const cfg = JSON.parse(fs.readFileSync(
    path.join(process.env.HOME, '.config/configstore/firebase-tools.json'), 'utf8'));
  return cfg.tokens.access_token;
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
const httpGet  = (url, t)       => httpReq('GET',  url, t, null);
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
const arr  = values => ({ arrayValue: { values: values ?? [] } });
const map  = fields => ({ mapValue: { fields } });

function upsert(project, docPath, fields) {
  return { update: { name: `projects/${project}/databases/(default)/documents/${docPath}`, fields } };
}

// ── Read from prod ─────────────────────────────────────────────────────────────

async function readProd(token) {
  const base = `https://firestore.googleapis.com/v1/projects/${PROD_PROJECT}/databases/(default)/documents`;

  const [eqRes, bookingsRes] = await Promise.all([
    httpGet(`${base}/companies/${PROD_COMPANY}/equipment?pageSize=200`, token),
    httpGet(`${base}/companies/${PROD_COMPANY}/bookings?pageSize=200`, token),
  ]);

  const equipment = eqRes.body.documents || [];
  const bookings  = bookingsRes.body.documents || [];

  // Fetch units per equipment in parallel (collectionGroup requires an index that may not exist)
  const unitBatches = await Promise.all(
    equipment.map(doc => {
      const eqId = doc.name.split('/').pop();
      return httpGet(`${base}/companies/${PROD_COMPANY}/equipment/${eqId}/units?pageSize=20`, token)
        .then(r => r.body.documents || []);
    })
  );
  const units = unitBatches.flat();

  console.log(`  Equipment: ${equipment.length}, Units: ${units.length}, Bookings: ${bookings.length}`);
  return { equipment, units, bookings };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  const env   = loadEnv();
  const token = getOAuthToken();

  // ── 1. Alpha Auth users ───────────────────────────────────────────────────

  console.log('\n── 1. Auth users on alpha ──────────────────────────────────────');

  const { initializeApp, cert } = require('firebase-admin/app');
  const { getAuth }             = require('firebase-admin/auth');
  initializeApp({ credential: cert(JSON.parse(env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON)), projectId: ALPHA_PROJECT });
  const auth = getAuth();

  const prodToAlpha = {};
  const alphaUsers  = [];

  for (const u of PROD_USERS) {
    let alphaUid;
    try {
      const existing = await auth.getUserByEmail(u.email);
      alphaUid = existing.uid;
      console.log(`  ${u.name}: already exists (${alphaUid})`);
      await auth.updateUser(alphaUid, { displayName: u.name });
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      const created = await auth.createUser({ email: u.email, password: TEMP_PASSWORD, displayName: u.name });
      alphaUid = created.uid;
      console.log(`  ${u.name}: created (${alphaUid})`);
    }
    await auth.setCustomUserClaims(alphaUid, { activeCompanyId: ALPHA_COMPANY, role: 'crew' });
    prodToAlpha[u.prodUid] = alphaUid;
    alphaUsers.push({ ...u, alphaUid });
  }

  const creatorUid = alphaUsers[0].alphaUid; // Alexander — used as createdBy on equipment

  // ── 2. Read prod ──────────────────────────────────────────────────────────

  console.log('\n── 2. Read prod data ───────────────────────────────────────────');
  const { equipment, units, bookings } = await readProd(token);

  // ── 3. ID maps ────────────────────────────────────────────────────────────

  console.log('\n── 3. Build ID maps ────────────────────────────────────────────');

  const eqMap   = {};  // prodEqId   → alphaEqId
  const unitMap = {};  // prodUnitId → alphaUnitId

  for (const doc of equipment) {
    eqMap[doc.name.split('/').pop()] = newId();
  }
  for (const doc of units) {
    unitMap[doc.name.split('/').pop()] = newId();
  }

  // ── 4. Build writes ───────────────────────────────────────────────────────

  console.log('\n── 4. Build Firestore writes ───────────────────────────────────');
  const writes = [];
  const joinedAt = new Date().toISOString();

  // User docs + member docs + membership docs
  for (const u of alphaUsers) {
    writes.push(upsert(ALPHA_PROJECT, `users/${u.alphaUid}`, {
      name:            str(u.name),
      email:           str(u.email.toLowerCase()),
      activeCompanyId: str(ALPHA_COMPANY),
    }));
    writes.push(upsert(ALPHA_PROJECT, `companies/${ALPHA_COMPANY}/members/${u.alphaUid}`, {
      uid:       str(u.alphaUid),
      name:      str(u.name),
      email:     str(u.email.toLowerCase()),
      role:      str('crew'),
      joinedAt:  ts(joinedAt),
      companyId: str(ALPHA_COMPANY),
    }));
    writes.push(upsert(ALPHA_PROJECT, `users/${u.alphaUid}/memberships/${ALPHA_COMPANY}`, {
      companyId: str(ALPHA_COMPANY),
      role:      str('crew'),
      joinedAt:  ts(joinedAt),
    }));
  }

  // Equipment docs — copy fields verbatim, swap createdBy to alpha user
  for (const doc of equipment) {
    const prodId  = doc.name.split('/').pop();
    const alphaId = eqMap[prodId];
    const fields  = { ...doc.fields, createdBy: str(creatorUid) };
    writes.push(upsert(ALPHA_PROJECT, `companies/${ALPHA_COMPANY}/equipment/${alphaId}`, fields));
  }

  // Unit docs — copy fields, update equipmentId + companyId
  for (const doc of units) {
    const prodUnitId = doc.name.split('/').pop();
    const alphaUnitId = unitMap[prodUnitId];
    const prodEqId    = doc.fields?.equipmentId?.stringValue;
    const alphaEqId   = eqMap[prodEqId];
    const fields = {
      ...doc.fields,
      equipmentId: str(alphaEqId),
      companyId:   str(ALPHA_COMPANY),
      createdBy:   str(creatorUid),
    };
    writes.push(upsert(ALPHA_PROJECT, `companies/${ALPHA_COMPANY}/equipment/${alphaEqId}/units/${alphaUnitId}`, fields));
  }

  // Booking docs — translate all IDs
  for (const doc of bookings) {
    const f = doc.fields;

    const alphaUserId  = prodToAlpha[f.userId?.stringValue] || null;
    const alphaEqIds   = (f.equipmentIds?.arrayValue?.values || []).map(v => eqMap[v.stringValue]).filter(Boolean);
    const alphaUnitIds = (f.unitIds?.arrayValue?.values || []).map(v => unitMap[v.stringValue]).filter(Boolean);

    const alphaItems = (f.items?.arrayValue?.values || []).map(itemVal => {
      const fi = itemVal.mapValue?.fields || {};
      const newFi = {
        equipmentId: str(eqMap[fi.equipmentId?.stringValue] || ''),
        quantity:    fi.quantity || { integerValue: '1' },
      };
      if (fi.unitId?.stringValue && unitMap[fi.unitId.stringValue]) {
        newFi.unitId = str(unitMap[fi.unitId.stringValue]);
      }
      return map(newFi);
    });

    // Pass through null-safe: keep nullValue fields as-is, remap non-null ones
    const passNull = field => field?.nullValue ? nil() : (field || nil());

    writes.push(upsert(ALPHA_PROJECT, `companies/${ALPHA_COMPANY}/bookings/${newId()}`, {
      projectName:      f.projectName      || str(''),
      userId:           alphaUserId ? str(alphaUserId) : nil(),
      userName:         nil(),
      notes:            f.notes            || str(''),
      status:           f.status           || str('confirmed'),
      requiresApproval: f.requiresApproval || { booleanValue: false },
      approvalStatus:   f.approvalStatus   || str('none'),
      approverId:       nil(),
      rejectionReason:  nil(),
      cancelledAt:      passNull(f.cancelledAt),
      cancelledBy:      passNull(f.cancelledBy),
      startDate:        f.startDate        || str(''),
      endDate:          f.endDate          || str(''),
      startTime:        passNull(f.startTime),
      endTime:          passNull(f.endTime),
      items:            arr(alphaItems),
      equipmentIds:     arr(alphaEqIds.map(str)),
      unitIds:          arr(alphaUnitIds.map(str)),
      createdAt:        f.createdAt        || ts(joinedAt),
      updatedAt:        f.updatedAt        || ts(joinedAt),
    }));
  }

  console.log(`  Total writes: ${writes.length}`);

  // ── 5. Commit ─────────────────────────────────────────────────────────────

  console.log('\n── 5. Commit to alpha ──────────────────────────────────────────');
  await commitBatch(token, ALPHA_PROJECT, writes);

  console.log('\n── Done ────────────────────────────────────────────────────────');
  console.log(`  Users:     ${alphaUsers.length}`);
  console.log(`  Equipment: ${equipment.length}`);
  console.log(`  Units:     ${units.length}`);
  console.log(`  Bookings:  ${bookings.length}`);
  console.log(`  Temp pw:   ${TEMP_PASSWORD}`);
}

run().catch(err => { console.error('\nFatal:', err.message || err); process.exit(1); });
