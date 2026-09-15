#!/usr/bin/env node
'use strict';

/**
 * Structural regression tests for the forward-only migration that revokes
 * client EXECUTE from two SECURITY DEFINER trigger functions
 * (Supabase advisors 0028/0029; audit AUD-P4-006 / AUD-P4-007):
 *   - public.set_user_entitlements_updated_at()   (20260829120000_kplus_entitlements.sql)
 *   - public.set_user_style_profiles_updated_at() (20260830060000_user_style_profiles.sql)
 *
 * These assert on the migration's SQL text -- there is no live Postgres in
 * this run. The file is located by name suffix because its version prefix is
 * whatever the staging ledger minted when it was applied. Live privileges
 * (has_function_privilege) and trigger firing were verified against
 * yzqjvdfgefveprobvvyw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const MIGRATION_PATTERN = /^(\d{14})_revoke_client_execute_on_updated_at_trigger_functions\.sql$/;
const CREATING_MIGRATIONS = ['20260829120000_kplus_entitlements.sql', '20260830060000_user_style_profiles.sql'];
const EXPECTED_TARGETS = ['set_user_entitlements_updated_at', 'set_user_style_profiles_updated_at'];

const matches = fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_PATTERN.test(f));
const migrationFile = matches[0];
const sql = migrationFile ? fs.readFileSync(path.join(MIGRATIONS_DIR, migrationFile), 'utf8') : '';

function stripLineComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

// Returns every way `text` departs from the reviewed shape; [] means clean.
function findViolations(text) {
  const code = stripLineComments(text);
  const violations = [];

  const targets = code.match(/v_targets\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i);
  const names = targets ? [...targets[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : [];
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TARGETS)) {
    violations.push(`target list is [${names.join(', ')}], expected [${EXPECTED_TARGETS.join(', ')}]`);
  }

  const guard =
    /if\s+exists\s*\(\s*select\s+1\s+from\s+pg_proc\s+p\s+join\s+pg_namespace\s+n\s+on\s+n\.oid\s*=\s*p\.pronamespace\s+where\s+n\.nspname\s*=\s*'public'\s+and\s+p\.proname\s*=\s*v_target\s+and\s+p\.pronargs\s*=\s*0\s*\)\s*then/i;
  if (!guard.test(code)) {
    violations.push('revoke is not guarded by a public-schema, zero-argument pg_proc existence check');
  }

  if (/^\s*revoke\b/im.test(code)) {
    violations.push('bare top-level REVOKE statement (aborts the whole file if the function is missing)');
  }

  const dynamicRevoke = code.match(/'revoke execute on function public\.%I\(\) from ([^']+)'/i);
  const roles = dynamicRevoke ? dynamicRevoke[1].split(',').map((r) => r.trim().toLowerCase()) : [];
  for (const role of ['anon', 'authenticated']) {
    if (!roles.includes(role)) violations.push(`EXECUTE is not revoked from ${role}`);
  }
  if (roles.includes('service_role')) violations.push('EXECUTE is revoked from service_role');

  if (/\bgrant\b/i.test(code)) violations.push('contains a GRANT');
  if (/\b(create|alter|drop)\s+(or\s+replace\s+)?(trigger|function|table)\b/i.test(code)) {
    violations.push('changes a trigger, function definition, or table');
  }
  if (/\bsecurity\s+invoker\b|\bcascade\b/i.test(code)) violations.push('changes function security or cascades');

  return violations;
}

test('exactly one revoke migration exists', () => {
  assert.equal(matches.length, 1, `expected one matching migration, found: ${matches.join(', ') || 'none'}`);
});

test('the revoke replays after both migrations that create the functions', () => {
  const version = MIGRATION_PATTERN.exec(migrationFile)[1];
  for (const creator of CREATING_MIGRATIONS) {
    assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, creator)), `${creator} is missing`);
    assert.ok(version > creator.slice(0, 14), `${migrationFile} must sort after ${creator}`);
  }
});

test('the migration revokes anon/authenticated EXECUTE from exactly the two trigger functions, guarded and nothing else', () => {
  assert.deepEqual(findViolations(sql), []);
});

test('negative controls: each unsafe variant of the migration is detected', () => {
  const mutants = {
    'bare revoke': `revoke execute on function public.set_user_entitlements_updated_at() from anon, authenticated;\n${sql}`,
    'guard loses its signature check': sql.replace('and p.pronargs = 0', ''),
    'authenticated left executable': sql.replace('from public, anon, authenticated', 'from public, anon'),
    'service_role revoked': sql.replace('from public, anon, authenticated', 'from public, anon, authenticated, service_role'),
    'target dropped': sql.replace("'set_user_style_profiles_updated_at'", ''),
    'grant added': `${sql}\ngrant execute on function public.set_user_entitlements_updated_at() to anon;\n`,
    'trigger dropped': `${sql}\ndrop trigger user_entitlements_updated_at on public.user_entitlements;\n`,
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, sql, `mutant "${label}" did not change the SQL`);
    assert.notDeepEqual(findViolations(mutant), [], `mutant "${label}" was not detected`);
  }
});
