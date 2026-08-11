#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  RISK_CLASSES,
  CLASSIFICATION_STATUS,
  DETECTOR_VERDICT,
  detectRiskPatterns,
  classifyMigration,
  assessMigration,
  loadRegistries,
} = require('../../security/release/classify-migration-risk');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'migrations');
const registries = loadRegistries(REPO_ROOT);

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function findingIds(sql) {
  return detectRiskPatterns(sql).findings.map((f) => f.id);
}

// ---- true-positive fixtures ----

test('DROP TABLE fixture is DETECTED_RISK', () => {
  const result = detectRiskPatterns(fixture('true_positive_drop_table.sql'));
  assert.equal(result.verdict, DETECTOR_VERDICT.DETECTED_RISK);
  assert.ok(result.findings.some((f) => f.id === 'DROP_TABLE'));
});

test('DROP COLUMN fixture is DETECTED_RISK', () => {
  const result = detectRiskPatterns(fixture('true_positive_drop_column.sql'));
  assert.equal(result.verdict, DETECTOR_VERDICT.DETECTED_RISK);
  assert.ok(result.findings.some((f) => f.id === 'DROP_COLUMN'));
});

test('TRUNCATE fixture is DETECTED_RISK', () => {
  const result = detectRiskPatterns(fixture('true_positive_truncate.sql'));
  assert.equal(result.verdict, DETECTOR_VERDICT.DETECTED_RISK);
  assert.ok(result.findings.some((f) => f.id === 'TRUNCATE'));
});

test('enum value removal fixture is DETECTED_RISK', () => {
  const result = detectRiskPatterns(fixture('true_positive_enum_removal.sql'));
  assert.equal(result.verdict, DETECTOR_VERDICT.DETECTED_RISK);
  assert.ok(result.findings.some((f) => f.id === 'ENUM_VALUE_REMOVAL'));
});

test('unbounded DELETE fixture requires classification', () => {
  const result = detectRiskPatterns(fixture('true_positive_unbounded_delete.sql'));
  assert.ok(result.findings.some((f) => f.id === 'UNBOUNDED_DELETE'));
  assert.equal(result.verdict, DETECTOR_VERDICT.REQUIRES_CLASSIFICATION);
});

test('NOT NULL tightening fixture requires classification', () => {
  const result = detectRiskPatterns(fixture('true_positive_not_null_tightening.sql'));
  assert.ok(result.findings.some((f) => f.id === 'NOT_NULL_TIGHTENING'));
  assert.equal(result.verdict, DETECTOR_VERDICT.REQUIRES_CLASSIFICATION);
});

test('CREATE OR REPLACE FUNCTION on a SECURITY DEFINER body is surfaced for review', () => {
  const result = detectRiskPatterns(fixture('review_shape_security_definer_replace.sql'));
  assert.ok(result.findings.some((f) => f.id === 'SECURITY_DEFINER_REPLACE'));
  assert.equal(result.verdict, DETECTOR_VERDICT.REQUIRES_REVIEW);
});

// ---- false-positive fixtures ----

test('commented-out destructive DDL is never flagged', () => {
  const ids = findingIds(fixture('false_positive_commented_drop.sql'));
  for (const forbidden of ['DROP_TABLE', 'DROP_COLUMN', 'TRUNCATE']) {
    assert.ok(!ids.includes(forbidden), `comment-only ${forbidden} must not be detected, got ${ids.join(', ')}`);
  }
  assert.equal(detectRiskPatterns(fixture('false_positive_commented_drop.sql')).verdict, DETECTOR_VERDICT.NO_PATTERN_DETECTED);
});

test('purely additive migration is not DETECTED_RISK', () => {
  const result = detectRiskPatterns(fixture('false_positive_expansion_safe.sql'));
  assert.notEqual(result.verdict, DETECTOR_VERDICT.DETECTED_RISK);
  assert.ok(!result.findings.some((f) => f.severity === 'DESTRUCTIVE_SHAPE'));
});

test('WHERE-bounded DELETE does not trip the unbounded-delete rule', () => {
  const ids = findingIds(fixture('false_positive_bounded_delete.sql'));
  assert.ok(!ids.includes('UNBOUNDED_DELETE'), `bounded DELETE must not be UNBOUNDED_DELETE, got ${ids.join(', ')}`);
});

test('REVOKE TRUNCATE (a privilege name) is not mistaken for a TRUNCATE statement', () => {
  // Regression guard: an earlier detector version matched the bare word
  // "truncate" anywhere, so three real privilege-tightening migrations in
  // this repo were wrongly reported as DETECTED_RISK.
  const result = detectRiskPatterns(fixture('false_positive_revoke_truncate_privilege.sql'));
  assert.ok(!result.findings.some((f) => f.id === 'TRUNCATE'), 'revoked TRUNCATE privilege must not be a TRUNCATE finding');
  assert.notEqual(result.verdict, DETECTOR_VERDICT.DETECTED_RISK);
});

test('no historical repository migration is reported as DETECTED_RISK', () => {
  // Phase 1 discovery established that the recent migration history contains
  // no destructive DDL. If this fails, either a genuinely destructive
  // migration landed or the detector regressed into false positives - both
  // warrant a human look rather than a silent threshold bump.
  const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const result = detectRiskPatterns(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (result.verdict === DETECTOR_VERDICT.DETECTED_RISK) {
      offenders.push(`${file}: ${result.findings.filter((f) => f.severity === 'DESTRUCTIVE_SHAPE').map((f) => f.id).join(', ')}`);
    }
  }
  assert.deepEqual(offenders, [], `unexpected destructive-shape findings: ${offenders.join(' | ')}`);
});

test('a WHERE clause on a later line still binds to its DELETE statement', () => {
  // Regression guard: an early detector version used the `m` flag, so `$`
  // matched end-of-line and a WHERE on the next line was invisible, making
  // every multi-line bounded DELETE a false UNBOUNDED_DELETE.
  const multiline = 'delete from public.t\n  where id = 1;';
  assert.ok(!findingIds(multiline).includes('UNBOUNDED_DELETE'));
  assert.ok(findingIds('delete from public.t;').includes('UNBOUNDED_DELETE'));
});

test('a semicolon inside a routine body does not split the statement it belongs to', () => {
  // Regression guard: naive `;` splitting fragments a function body, which
  // would separate a WHERE clause from its DELETE and yield a false positive.
  const sql = [
    'create or replace function public.sweep() returns void language plpgsql as $$',
    'begin',
    "  delete from public.rate_limits where updated_at < now() - interval '1 day';",
    'end;',
    '$$;',
  ].join('\n');
  const ids = findingIds(sql);
  assert.ok(!ids.includes('UNBOUNDED_DELETE'), `bounded DELETE in a routine must not be UNBOUNDED_DELETE, got ${ids.join(', ')}`);
  assert.ok(ids.includes('DELETE_INSIDE_ROUTINE_BODY'), 'a DELETE inside a routine body should still be surfaced for review');
});

test('a DELETE outside any routine body is not reported as an in-routine risk', () => {
  const ids = findingIds('delete from public.t where id = 1;');
  assert.ok(!ids.includes('DELETE_INSIDE_ROUTINE_BODY'));
});

test('UNBOUNDED_UPDATE fires only for a genuinely unqualified UPDATE', () => {
  assert.ok(findingIds('update public.t set a = 1;').includes('UNBOUNDED_UPDATE'));
  assert.ok(!findingIds('update public.t set a = 1 where id = 2;').includes('UNBOUNDED_UPDATE'));
  assert.ok(!findingIds('update public.t\n  set a = 1\n  where id = 2;').includes('UNBOUNDED_UPDATE'));
});

test('a false positive never silently becomes destructive: detector output alone yields no risk class', () => {
  // The detector reports verdicts/findings only. It has no code path that
  // emits a RISK_CLASSES member, so a regex hit can never itself classify a
  // migration as DESTRUCTIVE - only the registry can.
  const result = detectRiskPatterns(fixture('true_positive_drop_table.sql'));
  assert.ok(!RISK_CLASSES.includes(result.verdict));
  assert.equal(result.classification, undefined);
});

// ---- authoritative classification registry ----

test('a migration classified in the registry resolves to its recorded class', () => {
  const result = classifyMigration('provider_request_security', registries);
  assert.equal(result.status, CLASSIFICATION_STATUS.CLASSIFIED);
  assert.equal(result.classification, 'EXPANSION_SAFE');
});

test('a historical migration absent from the registry is grandfathered, not blocking', () => {
  const result = classifyMigration('profiles_base', registries);
  assert.equal(result.status, CLASSIFICATION_STATUS.UNCLASSIFIED_HISTORICAL);
  assert.equal(result.classification, null);
});

test('a brand-new unclassified migration is UNCLASSIFIED_NEW', () => {
  const result = classifyMigration('some_migration_invented_after_the_baseline', registries);
  assert.equal(result.status, CLASSIFICATION_STATUS.UNCLASSIFIED_NEW);
  assert.equal(result.classification, null);
});

test('every registry classification uses a declared risk class', () => {
  for (const [name, entry] of Object.entries(registries.classifications.classifications)) {
    assert.ok(RISK_CLASSES.includes(entry.classification), `${name} has invalid class ${entry.classification}`);
    assert.ok(entry.rationale && entry.rationale.length > 0, `${name} must record a rationale`);
  }
});

test('an unknown risk class in a registry entry is rejected rather than trusted', () => {
  const poisoned = {
    baseline: registries.baseline,
    classifications: { classifications: { evil: { classification: 'TOTALLY_FINE', rationale: 'nope' } } },
  };
  assert.throws(() => classifyMigration('evil', poisoned), /unknown risk class/);
});

// ---- detector vs registry disagreement ----

test('detector risk against an additive-claimed class is surfaced as a mismatch, not auto-resolved', () => {
  const poisoned = {
    baseline: registries.baseline,
    classifications: {
      classifications: { sneaky: { classification: 'EXPANSION_SAFE', rationale: 'claims to be additive' } },
    },
  };
  const result = assessMigration({
    name: 'sneaky',
    sql: fixture('true_positive_drop_table.sql'),
    registries: poisoned,
  });
  assert.equal(result.detectorClassificationMismatch, true);
  // The recorded class is preserved as-is - the detector never downgrades or overrides it.
  assert.equal(result.classification, 'EXPANSION_SAFE');
  assert.equal(result.detectorVerdict, DETECTOR_VERDICT.DETECTED_RISK);
});

test('a registry entry may pre-acknowledge an expected detector mismatch', () => {
  const result = assessMigration({
    name: 'harden_public_rpc_execution_grants',
    sql: 'create or replace function public.x() returns void language sql as $$ select 1 $$;',
    registries,
  });
  assert.equal(result.detectorClassificationMismatch, false);
});

test('assessMigration on a real repository migration resolves without throwing', () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'migrations', '20260808121216_privacy_request_rate_limits.sql'),
    'utf8',
  );
  const result = assessMigration({ name: 'privacy_request_rate_limits', sql, registries });
  assert.equal(result.status, CLASSIFICATION_STATUS.CLASSIFIED);
  assert.equal(result.classification, 'EXPANSION_SAFE');
  assert.equal(result.detectorClassificationMismatch, false);
});

test('migration baseline snapshot matches the migrations actually present in the repository', () => {
  const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const inBaseline = registries.baseline.migrations.map((m) => path.basename(m.file)).sort();
  assert.deepEqual(inBaseline, onDisk, 'migration-baseline.json must match supabase/migrations/*.sql exactly');
  assert.equal(registries.baseline.count, onDisk.length);
});
