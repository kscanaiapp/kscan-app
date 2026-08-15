/**
 * KSB29-036 — AI-output reporting: reverse source/staging drift.
 *
 * THE DIRECTION OF THIS DEFECT IS UNUSUAL AND WORTH STATING PLAINLY.
 * Production is AHEAD of the repository, not behind it. `ai_output_context` and
 * `target_type = 'ai_output'` are live in production and the shipping client
 * writes them — but no migration in this repository ever declared them. A
 * database built from migration history (which is what App Staging is) rejects
 * every AI-output report at content_reports_target_type_check.
 *
 * So production serves the feature, and staging cannot certify it. The repair
 * is a NEW FORWARD migration that makes the repository state what production
 * already is — not the removal of a production capability, and not an edit to
 * migration history.
 *
 * Live state verified against both projects on 2026-08-15:
 *   production  wyyuqfdxucjksghsmhry  ai_output present, ai_output_context jsonb present
 *   app staging yzqjvdfgefveprobvvyw  both absent
 *
 * The migration body was additionally applied to App Staging inside a
 * transaction and rolled back; the resulting pg_get_constraintdef output was
 * byte-identical to production's, and staging was left unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20260815120000_content_reports_ai_output.sql';

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
}

test('a forward migration declares the AI-output reporting contract', () => {
  const names = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
  assert.ok(names.includes(MIGRATION), 'the AI-output forward migration must exist');

  const sql = readMigration(MIGRATION);

  // The column and the widened target type — the two things whose absence made
  // every AI-output report fail against a migration-built database.
  assert.match(sql, /add column if not exists ai_output_context jsonb/i);
  assert.match(sql, /'user',\s*'ai_output'/i, "target_type must admit 'ai_output'");

  // Idempotent: it must be safe to re-run, and a no-op against production,
  // which already has all of this.
  assert.match(sql, /add column if not exists/i);
  const addedConstraints = sql.match(/add constraint (\w+)/gi) || [];
  assert.ok(addedConstraints.length >= 2, 'both constraints must be (re)declared');
  for (const added of addedConstraints) {
    const name = added.replace(/add constraint /i, '');
    assert.match(
      sql,
      new RegExp(`drop constraint if exists ${name}`, 'i'),
      `${name} must be dropped-if-exists before being added, or re-running fails`,
    );
  }
});

test('history is not rewritten: the original content_reports migration is untouched', () => {
  // The capability must arrive as a new forward migration. Editing the applied
  // 20260708090847 migration would diverge every environment that already ran it.
  const original = readMigration('20260708090847_content_reports.sql');
  assert.doesNotMatch(
    original,
    /ai_output/i,
    'the already-applied content_reports migration must not be edited',
  );
});

test('the migration accepts exactly the payload the shipping client sends', () => {
  const sql = readMigration(MIGRATION);

  // services/reportAiOutput.ts builds ai_output_context from these keys only,
  // and the three feature labels are its declared AiOutputReportFeature union.
  // If either side drifts, reports start failing in production rather than in
  // a test, so the two are pinned against each other here.
  const client = fs.readFileSync(path.join(ROOT, 'services', 'reportAiOutput.ts'), 'utf8');

  for (const feature of ['StyleChat', 'TextScan', 'Scan Results']) {
    assert.ok(client.includes(`'${feature}'`), `client declares the ${feature} label`);
    assert.ok(sql.includes(`'${feature}'`), `migration admits the ${feature} label`);
  }

  for (const key of ['feature', 'reason_detail', 'session_id', 'message_id', 'item_id']) {
    assert.match(
      sql,
      new RegExp(`'${key}'`),
      `the context allowlist must include ${key}, which the client sends`,
    );
  }

  // Every reason id the client can submit must be admitted by the constraint.
  const reasonIds = [...client.matchAll(/id: '([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(reasonIds.length >= 3, 'the client must declare report reasons');
  for (const id of reasonIds) {
    assert.ok(sql.includes(`'${id}'`), `migration must admit reason_detail '${id}'`);
  }

  // The allowlist is a subtraction, so an unexpected key fails rather than
  // being stored. This is what keeps raw model prose out of the column.
  assert.match(
    sql,
    /ai_output_context - array\[/i,
    'the context contract must be a key allowlist, not an open jsonb column',
  );

  // An AI-output report is about a model response, never a person or a room.
  assert.match(sql, /reported_user_id is null/i);
  assert.match(sql, /room_id is null/i);
});
