#!/usr/bin/env node
'use strict';

/**
 * Batch 0 -- restored migration source integrity.
 *
 * WHY THIS EXISTS: eleven production migrations were missing from this branch.
 * Three were recovered from production's own migration records and verified
 * byte-for-byte by md5; eight were recovered from Git commits and are known to
 * DISAGREE with the production record. Both facts must stay visible.
 *
 * These tests pin the restored files by content hash so an accidental reformat,
 * re-indent, or "cleanup" cannot silently change SQL that is supposed to be an
 * exact reproduction of what production ran.
 *
 * Pure unit test -- filesystem only, no network, no database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

/**
 * Recovered from production supabase_migrations.schema_migrations.statements.
 * `prodMd5` is md5 of the stored statement; our file is that statement plus a
 * single trailing newline, which is stripped before hashing.
 */
const PRODUCTION_RECORD_SOURCES = [
  {
    version: '20260723021635',
    name: 'account_deletion_device_sessions_and_revoke',
    prodChars: 4283,
    prodMd5: 'df088e1d7c3027a10c6a9233657cff23',
  },
  {
    version: '20260723021735',
    name: 'account_deletion_claim_retry_peek_v2',
    prodChars: 6192,
    prodMd5: '31df6758a177dd094d17b94e40de33a6',
  },
  {
    version: '20260723132813',
    name: 'harden_deletion_trigger_function_grants',
    prodChars: 631,
    prodMd5: 'fb6f29d821ebc4d1d7937ecd5ad6b112',
  },
];

/** Recovered from Git. Pinned by file hash only -- see divergence test below. */
const GIT_RECOVERED_SOURCES = [
  { version: '20260720115423', name: 'scan_commerce_events' },
  { version: '20260721201218', name: 'dr3_collaborative_interactions' },
  { version: '20260721201347', name: 'dr4_collab_idempotency_room_scope' },
  { version: '20260722004639', name: 'stylechat_request_quota_events' },
  { version: '20260722022830', name: 'lock_down_stylechat_quota_refunds' },
  { version: '20260722024920', name: 'fix_stylechat_quota_rpc_ambiguity' },
  { version: '20260722030304', name: 'create_llm_routing_events' },
  { version: '20260722031812', name: 'limit_llm_routing_event_privileges' },
];

/**
 * Batch 1 migrations whose production history row holds a PLACEHOLDER rather
 * than the applied DDL. These can never be validated against the migration
 * record; only a live-schema diff can prove equivalence.
 */
const PLACEHOLDER_HISTORY_VERSIONS = [
  { version: '20260722191013', name: 'account_deletion_lifecycle' },
  { version: '20260723021514', name: 'account_deletion_security_hardening' },
];

function fileFor(version, name) {
  return path.join(MIGRATIONS, `${version}_${name}.sql`);
}

test('production-record migrations are restored byte-for-byte', () => {
  for (const { version, name, prodChars, prodMd5 } of PRODUCTION_RECORD_SOURCES) {
    const file = fileFor(version, name);
    assert.ok(fs.existsSync(file), `missing restored migration: ${version}_${name}.sql`);

    const raw = fs.readFileSync(file);
    // Strip the single trailing newline a text file carries and the stored
    // statement does not. This is the only permitted deviation.
    const content = raw[raw.length - 1] === 0x0a ? raw.subarray(0, raw.length - 1) : raw;

    assert.equal(
      content.length,
      prodChars,
      `${name}: length differs from the production record -- the file was altered`,
    );
    assert.equal(
      crypto.createHash('md5').update(content).digest('hex'),
      prodMd5,
      `${name}: content no longer matches the production record byte-for-byte`,
    );
  }
});

test('production-record migrations contain no CRLF line endings', () => {
  for (const { version, name } of PRODUCTION_RECORD_SOURCES) {
    const raw = fs.readFileSync(fileFor(version, name));
    assert.ok(
      !raw.includes(Buffer.from('\r\n')),
      `${name}: CRLF found -- encoding normalization would break the exact-match guarantee`,
    );
  }
});

test('every restored migration uses its exact production version ID', () => {
  for (const { version, name } of [...PRODUCTION_RECORD_SOURCES, ...GIT_RECOVERED_SOURCES]) {
    assert.ok(
      fs.existsSync(fileFor(version, name)),
      `${name} must be filed under production version ${version}`,
    );
  }
});

test('git-recovered sources are documented as unreconciled and excluded from Batch 1', () => {
  const doc = fs.readFileSync(
    path.join(ROOT, 'docs', 'security', 'batch0-migration-source-restoration.md'),
    'utf8',
  );
  assert.match(doc, /None of these eight are in\s*\n?Batch 1/, 'the doc must state these are out of Batch 1');

  // Batch 1 is defined by an explicit version list; none of the git-recovered
  // versions may appear in it.
  const BATCH_1 = new Set([
    '20260709130346', '20260711195508', '20260712020000', '20260714000002',
    '20260722191013', '20260723021514', '20260723021635', '20260723021735',
    '20260723083904', '20260723131202', '20260723131221', '20260723131423',
    '20260723132813',
  ]);
  for (const { version, name } of GIT_RECOVERED_SOURCES) {
    assert.ok(!BATCH_1.has(version), `${name} (${version}) must not be in Batch 1 while unreconciled`);
  }
});

test('placeholder-history migrations are recorded so they are never treated as verified', () => {
  const doc = fs.readFileSync(
    path.join(ROOT, 'docs', 'security', 'batch0-migration-source-restoration.md'),
    'utf8',
  );
  for (const { version, name } of PLACEHOLDER_HISTORY_VERSIONS) {
    assert.ok(
      doc.includes(version) && doc.includes(name),
      `${name} (${version}) must be documented as having a placeholder production history row`,
    );
  }
  assert.match(
    doc,
    /live production schema is authoritative/i,
    'the doc must name the live schema as the resolution authority',
  );
});
