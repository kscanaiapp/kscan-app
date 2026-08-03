#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const crypto = require('crypto');

const {
  processQuarantineObject,
  checkRateLimit,
  findReusableCleanVerdict,
  buildCleanObjectKey,
  transientRetryCount,
  isTransientVerdict,
  DEFAULT_MAX_UPLOADS_PER_WINDOW,
  MAX_TRANSIENT_RETRIES,
} = require('../../security/scan-worker/scanQuarantineObject');
const { VERDICTS } = require('../../security/ingestion-gate/verdict');
const { loadPolicy, getFormatById } = require('../../security/ingestion-gate/policy');

const policy = loadPolicy();

function makeFakeDeps(overrides = {}) {
  const store = { verdicts: [], clean: {}, quarantineDeleted: [] };
  return {
    store,
    downloadQuarantineObject: overrides.downloadQuarantineObject,
    deleteQuarantineObject: async (id) => { store.quarantineDeleted.push(id); },
    uploadCleanObject: async (key, buf, mime) => { store.clean[key] = { buf, mime }; },
    queryRecentVerdictCount: async () => overrides.recentCount ?? 0,
    findExistingCleanVerdict: async () => overrides.existingClean ?? null,
    findPriorVerdictRowsForObject: async () => overrides.priorRows ?? [],
    insertVerdict: async (row) => { store.verdicts.push(row); },
  };
}

test('checkRateLimit: allows uploads under the per-window ceiling', () => {
  assert.equal(checkRateLimit(0).allowed, true);
  assert.equal(checkRateLimit(DEFAULT_MAX_UPLOADS_PER_WINDOW - 1).allowed, true);
});

test('checkRateLimit: denies at and above the ceiling, with a retry-after hint', () => {
  const result = checkRateLimit(DEFAULT_MAX_UPLOADS_PER_WINDOW);
  assert.equal(result.allowed, false);
  assert.ok(result.retryAfterSeconds > 0);
});

test('findReusableCleanVerdict: returns null when there is no existing verdict', () => {
  assert.equal(findReusableCleanVerdict(null), null);
});

test('findReusableCleanVerdict: returns null for a non-CLEAN verdict', () => {
  assert.equal(findReusableCleanVerdict({ verdict: 'REJECTED_TYPE', clean_object_id: 'x' }), null);
});

test('findReusableCleanVerdict: returns null for an expired verdict', () => {
  const expired = { verdict: 'CLEAN', clean_object_id: 'x', expires_at: new Date(Date.now() - 1000).toISOString() };
  assert.equal(findReusableCleanVerdict(expired, Date.now()), null);
});

test('findReusableCleanVerdict: returns the row for an unexpired CLEAN verdict', () => {
  const valid = { verdict: 'CLEAN', clean_object_id: 'x', expires_at: new Date(Date.now() + 1000).toISOString() };
  assert.equal(findReusableCleanVerdict(valid, Date.now()), valid);
});

test('buildCleanObjectKey: deterministic, content-addressed, server-controlled (never the client filename)', () => {
  const jpegFormat = getFormatById(policy, 'jpeg');
  const key1 = buildCleanObjectKey('user-1', 'abc123', jpegFormat);
  const key2 = buildCleanObjectKey('user-1', 'abc123', jpegFormat);
  assert.equal(key1, key2);
  assert.equal(key1, 'user-1/abc123.jpg');
});

test('isTransientVerdict / transientRetryCount classify correctly', () => {
  assert.equal(isTransientVerdict(VERDICTS.SCANNER_UNAVAILABLE), true);
  assert.equal(isTransientVerdict(VERDICTS.SCAN_TIMEOUT), true);
  assert.equal(isTransientVerdict(VERDICTS.REJECTED_MALWARE), false);
  assert.equal(isTransientVerdict(VERDICTS.CLEAN), false);
  const rows = [{ verdict: 'SCANNER_UNAVAILABLE' }, { verdict: 'CLEAN' }, { verdict: 'SCAN_TIMEOUT' }];
  assert.equal(transientRetryCount(rows), 2);
});

test('processQuarantineObject: a clean image is promoted, verdict recorded, quarantine object deleted', async () => {
  const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'green' } }).jpeg().toBuffer();
  const deps = makeFakeDeps({ downloadQuarantineObject: async () => jpeg });
  const result = await processQuarantineObject(deps, { quarantineObjectId: 'user-1/abc.jpg', userId: 'user-1', declaredMimeType: 'image/jpeg', policy });

  assert.equal(result.outcome, 'CLEAN');
  assert.equal(Object.keys(deps.store.clean).length, 1);
  assert.equal(deps.store.verdicts.length, 1);
  assert.equal(deps.store.verdicts[0].verdict, 'CLEAN');
  assert.equal(deps.store.verdicts[0].clean_object_id, result.cleanObjectId);
  assert.deepEqual(deps.store.quarantineDeleted, ['user-1/abc.jpg']);
});

test('processQuarantineObject: a rejected image is never promoted, and its bytes are never retained', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const deps = makeFakeDeps({ downloadQuarantineObject: async () => png });
  const result = await processQuarantineObject(deps, { quarantineObjectId: 'user-1/bad.jpg', userId: 'user-1', declaredMimeType: 'image/jpeg', policy });

  assert.equal(result.outcome, 'REJECTED');
  assert.equal(Object.keys(deps.store.clean).length, 0);
  assert.equal(deps.store.verdicts[0].verdict, 'REJECTED_TYPE');
  assert.equal(deps.store.verdicts[0].compressed_bytes, png.length); // size recorded for ops...
  assert.deepEqual(deps.store.quarantineDeleted, ['user-1/bad.jpg']); // ...but bytes themselves are deleted, never stored
});

test('processQuarantineObject: rate-limited users are deferred without downloading or processing anything', async () => {
  let downloadCalled = false;
  const deps = makeFakeDeps({ downloadQuarantineObject: async () => { downloadCalled = true; return Buffer.alloc(0); }, recentCount: 999 });
  const result = await processQuarantineObject(deps, { quarantineObjectId: 'user-1/x.jpg', userId: 'user-1', policy });
  assert.equal(result.outcome, 'DEFERRED_RATE_LIMITED');
  assert.equal(downloadCalled, false);
  assert.equal(deps.store.verdicts.length, 0);
});

test('processQuarantineObject: duplicate hash reuses the existing CLEAN verdict, never rescans or double-stores', async () => {
  const jpeg = await sharp({ create: { width: 30, height: 30, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  const sha256Original = crypto.createHash('sha256').update(jpeg).digest('hex');
  const existingClean = {
    verdict: 'CLEAN',
    clean_object_id: 'user-1/existing-clean.jpg',
    sha256_canonical: 'prior-canonical-hash',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    detected_format: 'jpeg', width: 30, height: 30, compressed_bytes: 1234,
  };
  const deps = makeFakeDeps({ downloadQuarantineObject: async () => jpeg, existingClean });
  const result = await processQuarantineObject(deps, { quarantineObjectId: 'user-1/dup.jpg', userId: 'user-1', declaredMimeType: 'image/jpeg', policy });

  assert.equal(result.outcome, 'CLEAN_REUSED');
  assert.equal(result.cleanObjectId, existingClean.clean_object_id);
  assert.equal(Object.keys(deps.store.clean).length, 0); // no NEW clean object was created
  assert.equal(deps.store.verdicts[0].clean_object_id, existingClean.clean_object_id);
  assert.deepEqual(deps.store.quarantineDeleted, ['user-1/dup.jpg']);
});

test('processQuarantineObject: a transient scanner failure schedules a retry and keeps the quarantine object', async () => {
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const fakeGate = async () => ({ ok: false, verdict: VERDICTS.SCANNER_UNAVAILABLE, userMessage: 'x', internalReason: 'test' });
  const deps = makeFakeDeps({ downloadQuarantineObject: async () => jpeg, priorRows: [] });
  deps.runIngestionGate = fakeGate;
  const result = await processQuarantineObject(deps, { quarantineObjectId: 'user-1/transient.jpg', userId: 'user-1', policy });

  assert.equal(result.outcome, 'TRANSIENT_RETRY_SCHEDULED');
  assert.equal(deps.store.quarantineDeleted.length, 0); // NOT deleted -- eligible for retry
});

test('processQuarantineObject: transient failures give up after MAX_TRANSIENT_RETRIES and clean up', async () => {
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const fakeGate = async () => ({ ok: false, verdict: VERDICTS.SCAN_TIMEOUT, userMessage: 'x', internalReason: 'test' });
  const priorRows = Array.from({ length: MAX_TRANSIENT_RETRIES - 1 }, () => ({ verdict: VERDICTS.SCAN_TIMEOUT }));
  const deps = makeFakeDeps({ downloadQuarantineObject: async () => jpeg, priorRows });
  deps.runIngestionGate = fakeGate;
  const result = await processQuarantineObject(deps, { quarantineObjectId: 'user-1/give-up.jpg', userId: 'user-1', policy });

  assert.equal(result.outcome, 'TRANSIENT_GIVEUP');
  assert.deepEqual(deps.store.quarantineDeleted, ['user-1/give-up.jpg']); // cleaned up after giving up
});
