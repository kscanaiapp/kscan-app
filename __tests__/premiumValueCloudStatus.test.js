'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(relative) {
  const module = { exports: {} };
  const src = fs.readFileSync(path.join(root, relative), 'utf8');
  vm.runInNewContext(ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports, Date, URL, process: { env: {} } });
  return module.exports;
}
const { projectCloudClosetStatus: project } = load('services/closet/closetCloudStatus.ts');
const proof = load('services/kplus/kplusCapabilityProof.ts');
const synced = { state: 'synced', serverId: 'owned-row', mediaState: 'ready', syncedLocalUpdatedAt: 'current' };
const input = { entitlement: 'active', syncing: false, restoring: false, readFailed: false, outboundProven: false, entries: { owned: synced }, items: [{ id: 'owned', updatedAt: 'current' }] };
test('no source/build/entitlement/historical evidence alone claims current sync', () => {
  assert.equal(project(input), 'SYNC READY');
  assert.equal(project({ ...input, outboundProven: true }), 'SYNCED ON THIS DEVICE');
  assert.equal(project({ ...input, outboundProven: true, items: [{ id: 'owned', updatedAt: 'edited' }] }), 'SYNC READY');
  assert.equal(project({ ...input, outboundProven: true, entries: {} }), 'SYNC READY');
});
test('kill/restart during outbound sync reconciles durable pending work to WILL RETRY', () => {
  const dirty = { ...input, entries: { owned: { ...synced, state: 'pending' } } };
  assert.equal(project({ ...dirty, syncing: true }), 'SYNCING');
  assert.equal(project(dirty), 'WILL RETRY');
});
test('kill/restart during restore cannot preserve a dead-process RESTORING/SYNCING marker', () => {
  assert.equal(project({ ...input, restoring: true }), 'RESTORING');
  assert.equal(project(input), 'SYNC READY');
  assert.equal(project({ ...input, readFailed: true }), 'RETRY NEEDED');
});
test('lapse and unresolved entitlement never claim cloud eligibility', () => {
  for (const state of ['eligible', 'expired', 'unavailable']) assert.equal(project({ ...input, entitlement: state, syncing: true }), 'K+ REQUIRED');
  for (const state of ['loading', 'error']) assert.equal(project({ ...input, entitlement: state }), 'RESOLVING');
});
test('proof requires runtime evidence, current environment/build, valid dates and expiry', () => {
  const record = { capability: 'cloud_closet', proofType: 'closet_outbound_sync', environment: 'staging', buildAuthority: 'build35-premium-value-v2', status: 'PROVEN_RUNTIME', provenAt: '2026-10-07T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z', evidenceRef: 'docs/audits/test-evidence.json' };
  const ctx = { environment: 'staging', buildAuthority: record.buildAuthority, nowMs: Date.parse('2026-10-07T12:00:00Z'), records: [record] };
  const has = context => proof.hasRuntimeCapabilityProof('cloud_closet', 'closet_outbound_sync', context);
  assert.equal(has(ctx), true);
  for (const overrides of [{ status: 'UNPROVEN' }, { status: 'PROVEN_SOURCE_ONLY' }, { environment: 'production' }, { buildAuthority: 'other' }, { evidenceRef: '' }, { expiresAt: '2026-10-07T12:00:00Z' }, { provenAt: '2026-10-09T00:00:00Z' }, { expiresAt: 'invalid' }]) assert.equal(has({ ...ctx, records: [{ ...record, ...overrides }] }), false);
  assert.equal(has({ ...ctx, records: [] }), false);
  assert.equal(proof.hasRuntimeCapabilityProof('cloud_closet', 'closet_cross_device_restore', ctx), false);
});
