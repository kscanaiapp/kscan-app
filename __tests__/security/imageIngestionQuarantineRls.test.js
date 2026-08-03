#!/usr/bin/env node
'use strict';

// Static analysis of the quarantine/clean/verdicts migrations -- mirrors the
// existing rls-storage-guard convention (structured-input pure functions),
// but here reading the actual migration SQL directly, since these are new
// objects that won't exist in a live project until the migration is applied
// to a real Supabase instance. Confirms quarantine isolation and clean-object
// promotion are enforced by policy, not just by convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const quarantineSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260803220000_image_ingestion_quarantine_storage.sql'), 'utf8');
const cleanSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260803220100_image_ingestion_clean_storage.sql'), 'utf8');
const verdictsSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260803220200_image_scan_verdicts.sql'), 'utf8');

function policyBlocksFor(sql, forClause) {
  const regex = new RegExp(`create policy[^;]*for ${forClause}[^;]*;`, 'gis');
  return sql.match(regex) || [];
}

test('quarantine bucket: an insert policy exists, scoped to the caller\'s own auth.uid() path prefix', () => {
  const inserts = policyBlocksFor(quarantineSql, 'insert');
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /auth\.uid\(\)/);
  assert.match(inserts[0], /image-ingestion-quarantine/);
});

test('quarantine bucket: NO select/update/delete policy exists for authenticated or anon (worker-only access)', () => {
  assert.equal(policyBlocksFor(quarantineSql, 'select').length, 0);
  assert.equal(policyBlocksFor(quarantineSql, 'update').length, 0);
  assert.equal(policyBlocksFor(quarantineSql, 'delete').length, 0);
});

test('quarantine bucket: is created as private (public: false)', () => {
  assert.match(quarantineSql, /'image-ingestion-quarantine'[\s\S]*?false/);
});

test('clean bucket: a select policy exists, scoped to the owner\'s own path prefix', () => {
  const selects = policyBlocksFor(cleanSql, 'select');
  assert.equal(selects.length, 1);
  assert.match(selects[0], /auth\.uid\(\)/);
});

test('clean bucket: NO insert/update/delete policy exists for authenticated or anon (only service_role, via the scan worker, can write)', () => {
  assert.equal(policyBlocksFor(cleanSql, 'insert').length, 0);
  assert.equal(policyBlocksFor(cleanSql, 'update').length, 0);
  assert.equal(policyBlocksFor(cleanSql, 'delete').length, 0);
});

test('clean bucket: is created as private (public: false)', () => {
  assert.match(cleanSql, /'image-ingestion-clean'[\s\S]*?false/);
});

test('image_scan_verdicts: RLS is enabled', () => {
  assert.match(verdictsSql, /alter table public\.image_scan_verdicts enable row level security/);
});

test('image_scan_verdicts: a select policy exists scoped to user_id = auth.uid()', () => {
  const selects = policyBlocksFor(verdictsSql, 'select');
  assert.equal(selects.length, 1);
  assert.match(selects[0], /user_id\s*=\s*auth\.uid\(\)/);
});

test('image_scan_verdicts: NO insert/update/delete policy exists for authenticated or anon ("no client ability to mark an object clean")', () => {
  assert.equal(policyBlocksFor(verdictsSql, 'insert').length, 0);
  assert.equal(policyBlocksFor(verdictsSql, 'update').length, 0);
  assert.equal(policyBlocksFor(verdictsSql, 'delete').length, 0);
});

test('image_scan_verdicts: anon has no grants at all', () => {
  assert.match(verdictsSql, /revoke all on public\.image_scan_verdicts from anon/);
});

test('image_scan_verdicts: verdict column is constrained to the documented enum', () => {
  const expected = ['PENDING', 'CLEAN', 'REJECTED_TYPE', 'REJECTED_SIZE', 'REJECTED_DIMENSIONS', 'REJECTED_MALWARE', 'REJECTED_MALFORMED', 'SCANNER_UNAVAILABLE', 'SCAN_TIMEOUT', 'REENCODE_FAILED'];
  for (const v of expected) {
    assert.match(verdictsSql, new RegExp(`'${v}'`), `expected verdict enum to include ${v}`);
  }
});

test('image_scan_verdicts: pending and expiry indexes exist for retention/cleanup jobs', () => {
  assert.match(verdictsSql, /image_scan_verdicts_pending_idx/);
  assert.match(verdictsSql, /image_scan_verdicts_expires_at_idx/);
});

test('image_scan_verdicts: a unique index on clean_object_id exists (downstream enforcement lookup)', () => {
  assert.match(verdictsSql, /create unique index if not exists image_scan_verdicts_clean_object_id_idx/);
});

test('quarantine and clean buckets both cap file_size_limit at the policy\'s pre-buffer streaming cap', () => {
  const { loadPolicy } = require('../../security/ingestion-gate/policy');
  const policy = loadPolicy();
  const expectedBytes = String(policy.requestLimits.preBufferStreamingCapBytes);
  assert.match(quarantineSql, new RegExp(expectedBytes));
  assert.match(cleanSql, new RegExp(expectedBytes));
});
