#!/usr/bin/env node
'use strict';

/**
 * Applies only the migration files a PR candidate introduces — never a
 * blanket `supabase db push`, which this project's staging history cannot
 * currently pass (staging carries migrations whose .sql files are absent
 * from some branches; `db push` refuses to run at all while that's true,
 * even with --include-all).
 *
 * For each candidate NOT_YET_APPLIED, this executes the migration's SQL
 * directly (`supabase db query --linked -f <file>`, which talks to the
 * database via the Management API and does not require full local/remote
 * migration parity) and then records the exact version as applied
 * (`supabase migration repair <version> --status applied --linked`). This
 * never touches any migration version outside the candidate list — no
 * `--include-all`, no `migration repair --status reverted`, no reset.
 *
 * Requires: SUPABASE_ACCESS_TOKEN in the environment, and the project
 * already `supabase link`-ed in the current working directory.
 *
 * Usage:
 *   node security/scripts/apply-candidate-migrations.js <baseSha> <headSha> <projectRef>
 *
 * Exits non-zero (and prints a JSON manifest to stdout regardless) on
 * MIGRATION_HISTORY_CONFLICT or OPERATIONAL_FAILURE.
 */

const { execFileSync } = require('node:child_process');

const {
  STATUS,
  OUTCOME,
  getCandidateMigrationFiles,
  classifyCandidates,
  deriveOutcome,
  assertNotProductionRef,
} = require('./select-candidate-migrations');

// shell:true only on Windows, where the npm-installed CLI resolves through a
// .cmd shim that execFileSync cannot invoke directly (confirmed: direct
// `execFileSync('supabase.cmd', ...)` fails with EINVAL — Windows batch files
// require shell mediation). CI's Linux runner gets a real binary from
// supabase/setup-cli and never takes this branch. shell:true does not escape
// array arguments (Node's own DEP0190 warning), which would be an injection
// risk if a candidate's file path or version reached this call unsanitized —
// they can't: select-candidate-migrations.js's FILENAME_RE only accepts
// [a-zA-Z0-9_] in the name segment and \d{14} for the version, so no argument
// passed through `run()` can ever contain a shell metacharacter.
function run(args) {
  return execFileSync('supabase', args, { encoding: 'utf8', shell: process.platform === 'win32' });
}

// `--linked` and `--project-ref` are mutually exclusive on these subcommands
// (the CLI rejects the combination outright) — `--linked` alone resolves to
// whatever project the workflow's prior `supabase link --project-ref <ref>`
// step already linked in this job's working directory. `projectRef` is still
// taken as a parameter so callers can pass it through for the
// assertNotProductionRef safety check, just never onto these command lines.

function getRemoteMigrationRows() {
  const out = run(['migration', 'list', '--linked', '--output-format', 'json']);
  const parsed = JSON.parse(out);
  return parsed.migrations || [];
}

function getRemoteMigrationNames() {
  const sql = "select version, name from supabase_migrations.schema_migrations";
  const out = run(['db', 'query', sql, '--linked', '--output-format', 'json']);
  const parsed = JSON.parse(out);
  const byVersion = {};
  for (const row of parsed.rows || []) {
    byVersion[row.version] = row.name;
  }
  return byVersion;
}

function applyOne(candidate) {
  run(['db', 'query', '--linked', '-f', candidate.path]);
  run(['migration', 'repair', candidate.version, '--status', 'applied', '--linked']);
}

function main() {
  const [baseSha, headSha, projectRef] = process.argv.slice(2);
  if (!baseSha || !headSha || !projectRef) {
    console.error('Usage: apply-candidate-migrations.js <baseSha> <headSha> <projectRef>');
    process.exit(2);
  }

  try {
    assertNotProductionRef(projectRef);
  } catch (err) {
    console.log(JSON.stringify({ outcome: OUTCOME.OPERATIONAL_FAILURE, error: err.message }, null, 2));
    process.exit(1);
  }

  const { candidates, excluded } = getCandidateMigrationFiles(baseSha, headSha);

  if (candidates.length === 0) {
    console.log(JSON.stringify({ baseSha, headSha, projectRef, outcome: OUTCOME.NO_CANDIDATE_MIGRATIONS, migrations: [], excluded }, null, 2));
    return;
  }

  let remoteMigrationRows;
  let remoteNameByVersion;
  try {
    remoteMigrationRows = getRemoteMigrationRows();
    remoteNameByVersion = getRemoteMigrationNames();
  } catch (err) {
    console.log(JSON.stringify({
      baseSha, headSha, projectRef,
      outcome: OUTCOME.OPERATIONAL_FAILURE,
      error: `failed to read remote migration state: ${err.message}`,
      candidates,
    }, null, 2));
    process.exit(1);
  }

  const classified = classifyCandidates(candidates, remoteMigrationRows, remoteNameByVersion);
  const preOutcome = deriveOutcome(classified);

  if (preOutcome === OUTCOME.MIGRATION_HISTORY_CONFLICT) {
    console.log(JSON.stringify({ baseSha, headSha, projectRef, outcome: preOutcome, migrations: classified, excluded }, null, 2));
    process.exit(1);
  }

  if (preOutcome === OUTCOME.ALREADY_APPLIED) {
    console.log(JSON.stringify({ baseSha, headSha, projectRef, outcome: preOutcome, migrations: classified, excluded }, null, 2));
    return;
  }

  // preOutcome === APPLIED: execute each NOT_YET_APPLIED candidate, in order,
  // stopping and reporting OPERATIONAL_FAILURE on the first failure so a
  // partial-apply state is visible rather than silently continuing.
  const finalMigrations = [];
  for (const c of classified) {
    if (c.status !== STATUS.NOT_YET_APPLIED) {
      finalMigrations.push(c);
      continue;
    }
    try {
      applyOne(c);
      finalMigrations.push({ ...c, status: 'APPLIED' });
    } catch (err) {
      finalMigrations.push({ ...c, status: OUTCOME.OPERATIONAL_FAILURE, error: err.message });
      console.log(JSON.stringify({
        baseSha, headSha, projectRef,
        outcome: OUTCOME.OPERATIONAL_FAILURE,
        migrations: finalMigrations,
        excluded,
      }, null, 2));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ baseSha, headSha, projectRef, outcome: OUTCOME.APPLIED, migrations: finalMigrations, excluded }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { getRemoteMigrationRows, getRemoteMigrationNames, applyOne };
