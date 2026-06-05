/**
 * One-off script: creates 5 test users in prod and adds them to MrTest company.
 *
 * Uses Firebase CLI's stored OAuth token as Admin SDK credential.
 *
 * Run from repo root:
 *   node tools/seed-mrtest-users.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const COMPANY_ID = 'yd8eIat7BZcJZs8eiw76';
const TEMP_PASSWORD = 'Allocate2026!';

const USERS = [
  { name: 'Alexander Miller', email: 'swordh+alexander@gmail.com' },
  { name: 'Lucas Silva',      email: 'swordh+lucas@gmail.com' },
  { name: 'Sebastian Novak',  email: 'swordh+sebastian@gmail.com' },
  { name: 'Sofia Rossi',      email: 'swordh+sofia@gmail.com' },
  { name: 'Maya Andersson',   email: 'swordh+maya@gmail.com' },
];

// ── Read CLI token ────────────────────────────────────────────────────────────

const CONFIGSTORE_PATH = path.join(
  process.env.HOME,
  '.config/configstore/firebase-tools.json',
);

function getCliToken() {
  const raw = fs.readFileSync(CONFIGSTORE_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const tokens = cfg.tokens;
  if (!tokens || !tokens.access_token) throw new Error('No access_token in firebase-tools configstore');
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: tokens.expires_at };
}

// ── Refresh token if expired ──────────────────────────────────────────────────

function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8czyznze0',
    refresh_token: refreshToken,
  });
  const res = await httpPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (res.status !== 200) throw new Error(`Token refresh failed: ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

async function getValidToken() {
  const { accessToken, refreshToken, expiresAt } = getCliToken();
  if (Date.now() < expiresAt - 60_000) {
    console.log('Using cached CLI access token.');
    return accessToken;
  }
  console.log('Token expired, refreshing…');
  return refreshAccessToken(refreshToken);
}

// ── Firebase Admin (custom credential) ───────────────────────────────────────

let _accessToken;

function makeCredential() {
  return {
    getAccessToken: () => Promise.resolve({ access_token: _accessToken, expires_in: 3600 }),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  _accessToken = await getValidToken();

  const { initializeApp } = require('firebase-admin/app');
  const { getAuth }       = require('firebase-admin/auth');

  initializeApp({
    credential: makeCredential(),
    projectId: 'allocate-e0735',
  });

  const auth = getAuth();
  const results = [];

  for (const user of USERS) {
    console.log(`\nProcessing: ${user.name} <${user.email}>`);

    // ── 1. Create (or re-use) Auth user ──────────────────────────────────────
    let uid;
    try {
      const existing = await auth.getUserByEmail(user.email);
      uid = existing.uid;
      console.log(`  Auth user already exists: ${uid}`);
      await auth.updateUser(uid, { displayName: user.name });
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        const created = await auth.createUser({
          email:       user.email,
          password:    TEMP_PASSWORD,
          displayName: user.name,
        });
        uid = created.uid;
        console.log(`  Created Auth user: ${uid}`);
      } else {
        throw err;
      }
    }

    // ── 2. Custom claims ──────────────────────────────────────────────────────
    await auth.setCustomUserClaims(uid, { activeCompanyId: COMPANY_ID, role: 'crew' });
    console.log(`  Claims set: { activeCompanyId: '${COMPANY_ID}', role: 'crew' }`);

    results.push({ name: user.name, email: user.email, uid });
  }

  console.log('\n── Auth done ─────────────────────────────────────────────');
  console.log('UIDs for Firestore step:');
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nTemporary password: ${TEMP_PASSWORD}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
