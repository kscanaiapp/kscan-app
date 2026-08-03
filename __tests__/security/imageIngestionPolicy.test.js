#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPolicy, getFormatById, getFormatByMime, maxAllowedBytes, DEFAULT_POLICY_PATH } = require('../../security/ingestion-gate/policy');

test('loadPolicy: the shipped policy file loads and validates', () => {
  const policy = loadPolicy();
  assert.ok(Array.isArray(policy.allowedFormats));
  assert.equal(policy.allowedFormats.length, 3);
});

test('loadPolicy: only jpeg, png, and webp are allowed (per policy decision)', () => {
  const policy = loadPolicy();
  const ids = policy.allowedFormats.map((f) => f.id).sort();
  assert.deepEqual(ids, ['jpeg', 'png', 'webp']);
});

test('loadPolicy: heic is explicitly documented as disallowed despite server.js historically accepting it', () => {
  const policy = loadPolicy();
  const heicEntry = policy.disallowedFormats.find((f) => f.id === 'heic');
  assert.ok(heicEntry, 'expected an explicit disallowedFormats entry for heic');
});

test('loadPolicy: every allowed format disallows animation (maxAnimationFrames=1)', () => {
  const policy = loadPolicy();
  for (const format of policy.allowedFormats) {
    assert.equal(format.maxAnimationFrames, 1, `${format.id} should disallow animation`);
  }
});

test('loadPolicy: throws on a malformed policy file (missing allowedFormats)', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), `bad-policy-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ notAllowedFormats: [] }));
  t.after(() => fs.unlinkSync(tmpFile));
  assert.throws(() => loadPolicy(tmpFile), /allowedFormats must be a non-empty array/);
});

test('loadPolicy: throws if a format is missing requiredMagicBytes', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), `bad-policy2-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ allowedFormats: [{ id: 'jpeg', maxCompressedBytes: 100 }] }));
  t.after(() => fs.unlinkSync(tmpFile));
  assert.throws(() => loadPolicy(tmpFile), /missing requiredMagicBytes/);
});

test('getFormatById / getFormatByMime resolve consistently', () => {
  const policy = loadPolicy();
  const byId = getFormatById(policy, 'jpeg');
  const byMime = getFormatByMime(policy, 'image/jpeg');
  assert.equal(byId, byMime);
  assert.equal(getFormatById(policy, 'not-a-format'), null);
  assert.equal(getFormatByMime(policy, 'image/gif'), null);
});

test('maxAllowedBytes: returns the largest maxCompressedBytes across all allowed formats', () => {
  const policy = loadPolicy();
  const expected = Math.max(...policy.allowedFormats.map((f) => f.maxCompressedBytes));
  assert.equal(maxAllowedBytes(policy), expected);
});

test('DEFAULT_POLICY_PATH points at security/uploads/image-ingestion-policy.json', () => {
  assert.match(DEFAULT_POLICY_PATH.replace(/\\/g, '/'), /security\/uploads\/image-ingestion-policy\.json$/);
});
