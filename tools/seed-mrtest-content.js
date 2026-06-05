/**
 * Seed script: creates all equipment, units, and bookings for MrTest in prod.
 * Uses Firestore REST API directly (firebase-admin Firestore requires service account).
 *
 * Run from repo root:
 *   node tools/seed-mrtest-content.js
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ID    = 'allocate-e0735';
const COMPANY_ID    = 'yd8eIat7BZcJZs8eiw76';
const DB            = `projects/${PROJECT_ID}/databases/(default)/documents`;
const COMMIT_URL    = `https://firestore.googleapis.com/v1/${DB}:commit`;
const CREATED_BY    = 'vXsxHo3PYLhjswsd9owCJT9zYcE3'; // Alexander Miller
const EQ_CREATED_AT = '2026-03-15T09:00:00Z';

const USERS = [
  'vXsxHo3PYLhjswsd9owCJT9zYcE3', // Alexander Miller  [0]
  'ODUKzVDNo8euSZ9LXuj5dtNpW9H2', // Lucas Silva        [1]
  'nLnZTw0TJcSz1K0y1ReCOqqDgq83', // Sebastian Novak   [2]
  'CQetb7hXLTfJb53JaJiwohIU49M2', // Sofia Rossi        [3]
  'SCkb6KM4XlOxRGnrSu9Yv9L4V8n2', // Maya Andersson     [4]
];

const FILM_CHARS = [
  'Ripley', 'Neo', 'Trinity', 'Morpheus', 'Yoda', 'Vader', 'Solo', 'Gandalf',
  'Frodo', 'Aragorn', 'Legolas', 'Gimli', 'Maverick', 'Goose', 'Iceman', 'Leia',
  'Kenobi', 'Grogu', 'Indy', 'McFly', 'Joker', 'Batman', 'Thor', 'Loki',
  'Thanos', 'Clarice', 'Hannibal', 'Sparrow', 'Forrest', 'McClane', 'Connor',
  'HAL', 'Blade', 'Rambo', 'Rocky', 'Katniss', 'Hermione', 'Snape', 'Draco',
  'Luna', 'Deckard', 'Batty', 'Rachael', 'Pris', 'Leon', 'Maximus', 'Commodus',
  'Marty', 'Doc', 'Biff', 'Walter', 'Jesse', 'Saul', 'Mike', 'Gus', 'Bond',
  'Vesper', 'Silva', 'Mulder', 'Scully', 'Hulk', 'Stark', 'Rogers', 'Hawkeye',
  'Fury', 'Starlord', 'Gamora', 'Groot', 'Rocket', 'Drax', 'Strange', 'Parker',
  'Panther', 'Wanda', 'Vision', 'Okoye', 'Shuri', 'Bucky', 'Pepper', 'Rhodey',
  'Furiosa', 'Nux', 'Toast', 'Bourne', 'Ethan', 'Luther',
];

let charIdx = 0;
function nextChar() { return FILM_CHARS[charIdx++ % FILM_CHARS.length]; }

// ── ID & random helpers ────────────────────────────────────────────────────────

function newId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let id = '';
  for (let i = 0; i < 20; i++) id += chars[bytes[i] % chars.length];
  return id;
}

function rnd(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// ── Firestore value helpers ────────────────────────────────────────────────────

const str  = (v)      => ({ stringValue: v });
const num  = (v)      => ({ integerValue: String(v) });
const bool = (v)      => ({ booleanValue: v });
const nil  = ()       => ({ nullValue: 'NULL_VALUE' });
const ts   = (v)      => ({ timestampValue: v });
const arr  = (values) => ({ arrayValue: { values: values ?? [] } });
const map  = (fields) => ({ mapValue: { fields } });

function docName(p) { return `${DB}/${p}`; }
function upsert(docPath, fields) { return { update: { name: docName(docPath), fields } }; }

// ── CLI token ──────────────────────────────────────────────────────────────────

function getToken() {
  const cfg = JSON.parse(fs.readFileSync(
    path.join(process.env.HOME, '.config/configstore/firebase-tools.json'), 'utf8'));
  return cfg.tokens.access_token;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

function httpPost(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
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

async function commitBatch(token, writes) {
  const CHUNK = 450;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const chunk = writes.slice(i, i + CHUNK);
    console.log(`  Committing ${chunk.length} writes (${i + 1}–${i + chunk.length} / ${writes.length})…`);
    const res = await httpPost(COMMIT_URL, token, { writes: chunk });
    if (res.status !== 200) {
      console.error('Commit error:', JSON.stringify(res.body, null, 2));
      throw new Error(`HTTP ${res.status}`);
    }
  }
}

// ── Equipment definitions ─────────────────────────────────────────────────────
// idx 0-49 referenced by BOOKING_SCENARIOS below

const EQ_DEFS = [
  // ── Camera [0-3] ──────────────────────────────────────────────────────────
  { name: 'Sony FX6 – Full-frame Cinema Line Camera',           cat: 'Camera',      type: 'units', n: 3, sn: 'SN-FX6' },
  { name: 'Sony FX3 – Full-frame Cinema Line Camera',           cat: 'Camera',      type: 'units', n: 2, sn: 'SN-FX3' },
  { name: 'Canon EOS C70 – Cinema EOS Camera',                  cat: 'Camera',      type: 'units', n: 2, sn: 'CN-C70' },
  { name: 'DJI Ronin 4D – 6K Cinematography System',           cat: 'Camera',      type: 'units', n: 2, sn: 'DJ-R4D' },
  // ── Lenses – Zoom [4-7] ───────────────────────────────────────────────────
  { name: 'Sigma 24-70mm f/2.8 DG DN Art',                     cat: 'Lenses',      type: 'units', n: 3, sn: 'SG-2470' },
  { name: 'Sony 16-35mm f/2.8 GM II',                          cat: 'Lenses',      type: 'units', n: 2, sn: 'SN-1635' },
  { name: 'Canon CN-E 30-105mm T2.8 L S – Cinema Zoom',        cat: 'Lenses',      type: 'units', n: 2, sn: 'CN-3105' },
  { name: 'Tamron 17-28mm f/2.8 Di III RXD',                   cat: 'Lenses',      type: 'units', n: 2, sn: 'TM-1728' },
  // ── Lenses – Prime Sony E [8-11] ──────────────────────────────────────────
  { name: 'Sony 35mm f/1.4 GM',                                cat: 'Lenses',      type: 'units', n: 2, sn: 'SN-35GM' },
  { name: 'Sony 50mm f/1.2 GM',                                cat: 'Lenses',      type: 'units', n: 2, sn: 'SN-50GM' },
  { name: 'Sony 85mm f/1.4 GM II',                             cat: 'Lenses',      type: 'units', n: 2, sn: 'SN-85GM' },
  { name: 'Sony 135mm f/1.8 GM',                               cat: 'Lenses',      type: 'units', n: 2, sn: 'SN-135G' },
  // ── Lenses – Prime Canon [12-14] ──────────────────────────────────────────
  { name: 'Canon CN-E 35mm T1.5 L F – Cinema Prime',           cat: 'Lenses',      type: 'units', n: 2, sn: 'CN-35LF' },
  { name: 'Canon CN-E 50mm T1.3 L F – Cinema Prime',           cat: 'Lenses',      type: 'units', n: 2, sn: 'CN-50LF' },
  { name: 'Canon CN-E 85mm T1.3 L F – Cinema Prime',           cat: 'Lenses',      type: 'units', n: 2, sn: 'CN-85LF' },
  // ── Lenses – Prime Zeiss [15-18] ──────────────────────────────────────────
  { name: 'Zeiss Milvus 21mm f/2.8',                           cat: 'Lenses',      type: 'units', n: 2, sn: 'ZS-M21' },
  { name: 'Zeiss Milvus 35mm f/2.0',                           cat: 'Lenses',      type: 'units', n: 2, sn: 'ZS-M35' },
  { name: 'Zeiss Milvus 85mm f/1.4',                           cat: 'Lenses',      type: 'units', n: 2, sn: 'ZS-M85' },
  { name: 'Zeiss Otus 100mm f/1.4',                            cat: 'Lenses',      type: 'units', n: 2, sn: 'ZS-O100' },
  // ── Lenses – Prime Sigma [19-22] ──────────────────────────────────────────
  { name: 'Sigma 20mm f/1.4 DG DN Art',                        cat: 'Lenses',      type: 'units', n: 2, sn: 'SG-20DN' },
  { name: 'Sigma 35mm f/1.4 DG DN Art',                        cat: 'Lenses',      type: 'units', n: 2, sn: 'SG-35DN' },
  { name: 'Sigma 85mm f/1.4 DG DN Art',                        cat: 'Lenses',      type: 'units', n: 2, sn: 'SG-85DN' },
  { name: 'Sigma 105mm f/2.8 DG DN Macro Art',                 cat: 'Lenses',      type: 'units', n: 2, sn: 'SG-105M' },
  // ── Audio [23-26] ─────────────────────────────────────────────────────────
  { name: 'Sound Devices MixPre-10 II – Field Recorder',       cat: 'Audio',       type: 'units', n: 2, sn: 'SD-MP10' },
  { name: 'Sennheiser EW 500 FILM G4 – Wireless Lavalier',     cat: 'Audio',       type: 'units', n: 3, sn: 'SH-EW5G' },
  { name: 'Rode NTG5 – Broadcast Shotgun Mic',                 cat: 'Audio',       type: 'units', n: 3, sn: 'RD-NTG5' },
  { name: 'DPA 4098 – Gooseneck Mic',                          cat: 'Audio',       type: 'units', n: 2, sn: 'DP-4098' },
  // ── Lighting – units [27-29] ──────────────────────────────────────────────
  { name: 'Aputure 600d Pro – LED Spotlight',                  cat: 'Lighting',    type: 'units', n: 3, sn: 'AP-600D' },
  { name: 'Aputure 300x – Bi-Color LED',                       cat: 'Lighting',    type: 'units', n: 4, sn: 'AP-300X' },
  { name: 'Nanlux Evoke 1200B – Bi-Color Spot',                cat: 'Lighting',    type: 'units', n: 2, sn: 'NL-1200' },
  // ── Lighting – quantity [30-31] ───────────────────────────────────────────
  { name: 'Aputure Light Dome II – Softbox 90cm',              cat: 'Lighting',    type: 'quantity', qty: 6 },
  { name: 'Aputure Light Dome Mini III – Softbox 55cm',        cat: 'Lighting',    type: 'quantity', qty: 8 },
  // ── Grip – units [32-34] ──────────────────────────────────────────────────
  { name: 'Sachtler Aktiv8 – Fluid Head Tripod',               cat: 'Grip',        type: 'units', n: 3, sn: 'SC-AK8' },
  { name: 'DJI RS 3 Pro – Gimbal Stabilizer',                  cat: 'Grip',        type: 'units', n: 3, sn: 'DJ-RS3' },
  { name: 'Tilta Nucleus-M II – Wireless Lens Control',        cat: 'Grip',        type: 'units', n: 3, sn: 'TL-NM2' },
  // ── Grip – quantity [35-38] ───────────────────────────────────────────────
  { name: 'C-Stand 40" – Steel Century Stand',                 cat: 'Grip',        type: 'quantity', qty: 12 },
  { name: 'C-Stand Arm 20" – Extension Arm',                   cat: 'Grip',        type: 'quantity', qty: 15 },
  { name: 'Sandbag 10kg',                                      cat: 'Grip',        type: 'quantity', qty: 12 },
  { name: 'Magic Arm – Super Clamp with Arm',                  cat: 'Grip',        type: 'quantity', qty: 10 },
  // ── Accessories – units [39-40] ───────────────────────────────────────────
  { name: 'Teradek Bolt 6 XT 750 – Wireless Video TX/RX',     cat: 'Accessories', type: 'units', n: 2, sn: 'TD-BL6' },
  { name: 'SmallHD Cine 7 – On-Camera Monitor',               cat: 'Accessories', type: 'units', n: 3, sn: 'SH-C7' },
  // ── Accessories – quantity cables [41-49] ─────────────────────────────────
  { name: 'XLR-kabel 10m – Balanced Audio Cable',             cat: 'Accessories', type: 'quantity', qty: 12 },
  { name: 'XLR-kabel 3m – Balanced Audio Cable',              cat: 'Accessories', type: 'quantity', qty: 15 },
  { name: 'TRS-kabel 6m – Stereo Jack Cable',                 cat: 'Accessories', type: 'quantity', qty: 8 },
  { name: 'Schuko-förlängning 10m – 3-fas',                   cat: 'Accessories', type: 'quantity', qty: 8 },
  { name: 'Schuko-förlängning 25m – 3-fas',                   cat: 'Accessories', type: 'quantity', qty: 5 },
  { name: 'Grenuttag 6-vägs – Överspänningsskydd',            cat: 'Accessories', type: 'quantity', qty: 10 },
  { name: 'BNC-kabel 10m – HD-SDI',                           cat: 'Accessories', type: 'quantity', qty: 8 },
  { name: 'HDMI-kabel 5m – High Speed 4K',                    cat: 'Accessories', type: 'quantity', qty: 10 },
  { name: 'Fiber HDMI 20m – Active Optical Cable',            cat: 'Accessories', type: 'quantity', qty: 5 },
];

// ── Booking scenarios ─────────────────────────────────────────────────────────
// items: [eqIdx, qty]  — qty=1 for unit-tracked (unit assigned automatically)

const SCENARIOS = [
  // ── Past – returned ───────────────────────────────────────────────────────
  { p: 'Volvo Campaign S/S 26',       u: 0, s: '2026-04-11', e: '2026-04-13', allDay: true,
    items: [[0,1],[4,1],[8,1],[23,1],[24,1],[27,1],[30,3],[35,6],[37,4]] },
  { p: 'H&M Lookbook AW26',           u: 1, s: '2026-04-14', e: '2026-04-14', allDay: true,
    items: [[1,1],[5,1],[9,1],[28,1],[31,3]] },
  { p: 'Spotify Brand Film',          u: 2, s: '2026-04-15', e: '2026-04-17', allDay: true,
    items: [[0,1],[6,1],[12,1],[23,1],[25,1],[29,1],[28,1],[35,4],[36,4]] },
  { p: 'IKEA Product Shoot',          u: 3, s: '2026-04-18', e: '2026-04-18', st: '09:00', et: '13:00',
    items: [[1,1],[10,1],[31,2]] },
  { p: 'SAS Cabin Crew TVC',          u: 4, s: '2026-04-20', e: '2026-04-23', allDay: true,
    items: [[0,1],[1,1],[4,1],[5,1],[2,1],[23,1],[24,1],[26,1],[27,1],[28,1],[29,1],[30,4],[35,8],[36,6],[37,6],[39,1],[40,1]] },
  { p: 'Absolut Vodka Launch',        u: 0, s: '2026-04-24', e: '2026-04-24', allDay: true,
    items: [[0,1],[13,1],[27,1],[30,2],[38,2]] },
  { p: 'Oatly Behind the Scenes',     u: 1, s: '2026-04-25', e: '2026-04-25', st: '13:00', et: '18:00',
    items: [[1,1],[7,1],[25,1]] },
  { p: 'Klarna Brand Refresh',        u: 2, s: '2026-04-27', e: '2026-04-28', allDay: true,
    items: [[0,1],[9,1],[14,1],[23,1],[28,1],[31,4],[35,4]] },
  { p: 'Ericsson Corporate Film',     u: 3, s: '2026-04-29', e: '2026-04-29', allDay: true,
    items: [[2,1],[6,1],[26,1],[25,1],[28,1],[40,1]] },
  { p: 'Vattenfall Climate Campaign', u: 4, s: '2026-05-02', e: '2026-05-04', allDay: true,
    items: [[0,1],[1,1],[8,1],[10,1],[23,1],[24,1],[27,1],[29,1],[30,3],[35,6],[37,4],[39,1]] },
  { p: 'Storytel Promo',              u: 0, s: '2026-05-05', e: '2026-05-05', st: '08:00', et: '12:00',
    items: [[1,1],[9,1],[31,2]] },
  { p: 'King Candy Crush TVC',        u: 1, s: '2026-05-05', e: '2026-05-07', allDay: true,
    items: [[3,1],[0,1],[4,1],[7,1],[11,1],[34,1],[23,1],[28,1],[31,4],[41,3],[44,2]] },
  { p: 'Northvolt Factory Tour',      u: 2, s: '2026-05-08', e: '2026-05-08', allDay: true,
    items: [[2,1],[6,1],[25,1],[40,1]] },
  { p: 'EQT Fund Launch Film',        u: 3, s: '2026-05-08', e: '2026-05-09', allDay: true,
    items: [[0,1],[8,1],[17,1],[23,1],[24,1],[27,1],[31,3],[35,4],[38,3]] },
  { p: 'Husqvarna Outdoor',           u: 4, s: '2026-05-09', e: '2026-05-09', st: '07:00', et: '12:30',
    items: [[1,1],[21,1],[25,1]] },
  { p: 'Sandvik Industrial',          u: 0, s: '2026-05-10', e: '2026-05-10', allDay: true,
    items: [[2,1],[12,1],[13,1],[26,1],[28,1],[40,1]] },
  // ── Today 2026-05-11 – 3 bookings ────────────────────────────────────────
  { p: 'Polestar Launch Event',       u: 1, s: '2026-05-11', e: '2026-05-11', st: '08:30', et: '13:00',
    items: [[0,1],[15,1],[24,1]] },
  { p: 'Einride AI Truck Film',       u: 2, s: '2026-05-11', e: '2026-05-11', allDay: true,
    items: [[0,1],[1,1],[4,1],[5,1],[23,1],[25,1],[27,1],[28,1],[35,4],[41,2]] },
  { p: 'Voi Scooter Campaign',        u: 3, s: '2026-05-11', e: '2026-05-11', st: '14:00', et: '18:30',
    items: [[1,1],[10,1],[33,1]] },
  // ── Tomorrow 2026-05-12 – 5 bookings ─────────────────────────────────────
  { p: 'Tibber Energy Film',          u: 4, s: '2026-05-12', e: '2026-05-12', allDay: true,
    items: [[2,1],[13,1],[28,1],[31,2]] },
  { p: 'Mentimeter Promo',            u: 0, s: '2026-05-12', e: '2026-05-12', st: '09:00', et: '12:30',
    items: [[1,1],[9,1],[24,1]] },
  { p: 'Truecaller Brand Film',       u: 1, s: '2026-05-12', e: '2026-05-14', allDay: true,
    items: [[0,1],[4,1],[14,1],[23,1],[24,1],[27,1],[29,1],[30,3],[35,6],[37,4],[39,1],[40,1]] },
  { p: 'Mojang Minecraft BTS',        u: 2, s: '2026-05-12', e: '2026-05-12', st: '13:00', et: '17:30',
    items: [[1,1],[7,1],[25,1]] },
  { p: 'Daniel Wellington AW26',      u: 3, s: '2026-05-12', e: '2026-05-15', allDay: true,
    items: [[0,1],[1,1],[10,1],[11,1],[17,1],[23,1],[24,1],[27,1],[28,1],[30,4],[35,6],[36,4],[37,6]] },
  // ── Future – confirmed ────────────────────────────────────────────────────
  { p: 'Acne Studios FW26',           u: 4, s: '2026-05-14', e: '2026-05-14', allDay: true,
    items: [[0,1],[18,1],[27,1],[31,2]] },
  { p: 'Filippa K Sustainability',    u: 0, s: '2026-05-16', e: '2026-05-18', allDay: true,
    items: [[0,1],[1,1],[8,1],[9,1],[23,1],[25,1],[28,1],[35,4],[38,3]] },
  { p: 'Gant Heritage Campaign',      u: 1, s: '2026-05-19', e: '2026-05-19', st: '10:00', et: '14:00',
    items: [[1,1],[20,1],[31,2]] },
  { p: 'Peak Performance Alpine',     u: 2, s: '2026-05-21', e: '2026-05-23', allDay: true,
    items: [[0,1],[1,1],[4,1],[7,1],[23,1],[24,1],[27,1],[29,1],[35,6],[37,4],[39,1]] },
  { p: 'Houdini Outdoor',             u: 3, s: '2026-05-22', e: '2026-05-22', allDay: true,
    items: [[2,1],[6,1],[26,1],[28,1],[40,1]] },
  { p: 'Fjällräven Pack Film',        u: 4, s: '2026-05-25', e: '2026-05-28', allDay: true,
    items: [[0,1],[1,1],[8,1],[4,1],[2,1],[23,1],[24,1],[26,1],[27,1],[28,1],[29,1],[30,4],[35,8],[36,6],[37,6],[39,1],[40,1],[41,4],[45,2]] },
  { p: 'Kånken x Studio Brand',       u: 0, s: '2026-05-27', e: '2026-05-27', st: '08:00', et: '13:00',
    items: [[1,1],[21,1],[24,1]] },
  { p: 'WESC Street Film',            u: 1, s: '2026-05-29', e: '2026-05-30', allDay: true,
    items: [[0,1],[5,1],[34,1],[33,1],[25,1],[28,1]] },
  { p: 'J.Lindeberg Golf TVC',        u: 2, s: '2026-06-01', e: '2026-06-01', allDay: true,
    items: [[0,1],[9,1],[27,1],[30,2]] },
  { p: 'Björn Borg Sport Campaign',   u: 3, s: '2026-06-03', e: '2026-06-05', allDay: true,
    items: [[0,1],[1,1],[10,1],[14,1],[23,1],[24,1],[27,1],[28,1],[30,3],[35,6],[37,4]] },
  { p: 'Tiger of Sweden FW26',        u: 4, s: '2026-06-06', e: '2026-06-06', st: '14:00', et: '18:30',
    items: [[1,1],[16,1],[31,2]] },
  { p: 'Oscar Jacobson Portrait',     u: 0, s: '2026-06-08', e: '2026-06-11', allDay: true,
    items: [[0,1],[18,1],[17,1],[11,1],[24,1],[27,1],[30,2],[35,4],[38,2]] },
  { p: 'Atlas Copco Product Film',    u: 1, s: '2026-06-09', e: '2026-06-09', st: '09:00', et: '13:30',
    items: [[2,1],[13,1],[28,1]] },
  { p: 'Boliden ESG Report',          u: 2, s: '2026-06-11', e: '2026-06-11', allDay: true,
    items: [[1,1],[8,1],[25,1],[28,1]] },
];

// ── Generate equipment data ────────────────────────────────────────────────────

const equipmentData = EQ_DEFS.map(def => ({
  id:       newId(),
  def,
  unitData: def.type === 'units'
    ? Array.from({ length: def.n }, () => ({ id: newId(), label: nextChar(), sn: `${def.sn}-${rnd(5)}` }))
    : [],
}));

// ── Build equipment + unit writes ─────────────────────────────────────────────

const writes = [];

for (const eq of equipmentData) {
  const eqFields = {
    name:               str(eq.def.name),
    category:           str(eq.def.cat),
    trackingType:       str(eq.def.type),
    totalQuantity:      num(eq.def.type === 'units' ? 1 : eq.def.qty),
    active:             bool(true),
    availableForBooking: bool(true),
    requiresApproval:   bool(false),
    approverId:         nil(),
    description:        nil(),
    customFields:       arr([]),
    createdAt:          ts(EQ_CREATED_AT),
    createdBy:          str(CREATED_BY),
  };
  writes.push(upsert(`companies/${COMPANY_ID}/equipment/${eq.id}`, eqFields));

  for (const unit of eq.unitData) {
    writes.push(upsert(`companies/${COMPANY_ID}/equipment/${eq.id}/units/${unit.id}`, {
      equipmentId:        str(eq.id),
      companyId:          str(COMPANY_ID),
      label:              str(unit.label),
      serialNumber:       str(unit.sn),
      status:             str('ok'),
      notes:              nil(),
      active:             bool(true),
      availableForBooking: bool(true),
      createdAt:          ts(EQ_CREATED_AT),
      createdBy:          str(CREATED_BY),
    }));
  }
}

console.log(`Equipment writes: ${writes.length} (${equipmentData.length} equipment, ${
  equipmentData.reduce((s, e) => s + e.unitData.length, 0)} units)`);

// ── Unit usage cycling (to vary units across bookings) ────────────────────────

const unitCursor = {};
function pickUnit(eq) {
  if (!unitCursor[eq.id]) unitCursor[eq.id] = 0;
  const unit = eq.unitData[unitCursor[eq.id] % eq.unitData.length];
  unitCursor[eq.id]++;
  return unit;
}

// ── Build booking writes ───────────────────────────────────────────────────────

const TODAY = '2026-05-11';

function bookingStatus(startDate) {
  if (startDate < TODAY)            return 'returned';
  if (startDate === TODAY)          return 'checked_out';
  return 'confirmed';
}

for (const sc of SCENARIOS) {
  const bId      = newId();
  const userId   = USERS[sc.u];
  const status   = bookingStatus(sc.s);
  const createdTs = `${sc.s}T07:00:00Z`;

  const itemMaps   = [];
  const eqIds      = [];
  const uIds       = [];

  for (const [eqIdx, qty] of sc.items) {
    const eq = equipmentData[eqIdx];
    if (eq.def.type === 'units') {
      const unit = pickUnit(eq);
      const itemFields = {
        equipmentId: str(eq.id),
        quantity:    num(1),
        unitId:      str(unit.id),
      };
      itemMaps.push(map(itemFields));
      eqIds.push(str(eq.id));
      uIds.push(str(unit.id));
    } else {
      itemMaps.push(map({ equipmentId: str(eq.id), quantity: num(qty) }));
      eqIds.push(str(eq.id));
    }
  }

  const bookingFields = {
    projectName:     str(sc.p),
    userId:          str(userId),
    userName:        nil(),
    notes:           str(''),
    status:          str(status),
    requiresApproval: bool(false),
    approvalStatus:  str('none'),
    approverId:      nil(),
    rejectionReason: nil(),
    cancelledAt:     nil(),
    cancelledBy:     nil(),
    startDate:       str(sc.s),
    endDate:         str(sc.e),
    startTime:       sc.allDay ? nil() : str(sc.st),
    endTime:         sc.allDay ? nil() : str(sc.et),
    items:           arr(itemMaps),
    equipmentIds:    arr(eqIds),
    unitIds:         arr(uIds),
    createdAt:       ts(createdTs),
    updatedAt:       ts(createdTs),
  };

  writes.push(upsert(`companies/${COMPANY_ID}/bookings/${bId}`, bookingFields));
}

console.log(`Total writes: ${writes.length} (equipment + units + ${SCENARIOS.length} bookings)`);

// ── Commit ─────────────────────────────────────────────────────────────────────

async function run() {
  const token = getToken();
  console.log('Committing to Firestore…');
  await commitBatch(token, writes);
  console.log('\nDone!');
  console.log(`  Equipment: ${equipmentData.length}`);
  console.log(`  Units:     ${equipmentData.reduce((s, e) => s + e.unitData.length, 0)}`);
  console.log(`  Bookings:  ${SCENARIOS.length}`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
