'use strict';
// Build 35 shared repair — the App Store listing may not promise more than the
// app can truthfully deliver (#567/#540/#572). Cloud Closet backup/restore is
// WITHHELD until a current Production runtime proof exists (see
// services/closet/cloudClosetRolloutAuthority.ts), and paid features must be
// named only inside the K+ "where available" qualifier, never as Free.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const info = JSON.parse(read('store.config.json')).apple.info['en-US'];

function load(relative, modules, env) {
  const module = { exports: {} };
  const require = id => { if (!(id in modules)) throw new Error(`unmapped import: ${id}`); return modules[id]; };
  vm.runInNewContext(ts.transpileModule(read(relative), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require, Date, URL, process: { env } });
  return module.exports;
}

function productionCloudClosetAuthorized() {
  const generated = load('services/kplus/kplusCapabilityFingerprints.generated.ts', {}, {});
  const proof = load('services/kplus/kplusCapabilityProof.ts', { './kplusCapabilityFingerprints.generated': generated },
    { EXPO_PUBLIC_SUPABASE_URL: 'https://wyyuqfdxucjksghsmhry.supabase.co' });
  const authority = load('services/closet/cloudClosetRolloutAuthority.ts', { '../kplus/kplusCapabilityProof': proof }, {});
  return { outbound: authority.isCloudClosetOutboundAuthorized(), restore: authority.isCloudClosetRestoreAuthorized() };
}

const CLOUD_CLAIM = /Cloud Closet|cloud backup|back up your Closet|backup|cross-device|across devices|restore (?:supported )?Closet/i;

test('no Cloud Closet backup/restore claim while Production rollout is withheld', () => {
  const production = productionCloudClosetAuthorized();
  if (production.outbound) return; // a real Production proof re-opens the claim deliberately
  for (const [field, text] of Object.entries({ description: info.description, releaseNotes: info.releaseNotes })) {
    assert.doesNotMatch(text, CLOUD_CLAIM, `${field} claims Cloud Closet without Production proof`);
  }
  // Purchase restoration is a different, required disclosure and must stay.
  assert.match(info.description, /purchase restoration available in the app/);
  assert.match(info.releaseNotes, /Restore Purchases/);
});

test('paid capabilities are named only inside the K+ availability qualifier', () => {
  const kplusAt = info.description.indexOf('Depending on feature and service availability, K+ experiences include');
  assert.notEqual(kplusAt, -1, 'description keeps the K+ availability qualifier');
  const notesAt = info.releaseNotes.indexOf('for K+ members where available');
  assert.notEqual(notesAt, -1, 'release notes qualify K+ features');
  for (const name of ['Packing Intelligence', 'Smart Watchlist', 'Voice Scan', 'AI Photo Virtual Try-On']) {
    const d = info.description.indexOf(name);
    assert.ok(d === -1 || d > kplusAt, `description presents ${name} outside the K+ qualifier`);
    const r = info.releaseNotes.indexOf(name);
    assert.ok(r === -1 || r > notesAt, `release notes present ${name} outside the K+ qualifier`);
  }
});

test('Free core still describes the local Closet without a cloud promise', () => {
  assert.match(info.description, /organize the fashion items you save in your Closet\./);
});
