#!/usr/bin/env node
'use strict';

/**
 * Selects and classifies the migration files a PR candidate actually introduces,
 * so the staging deploy job can apply only those — never a blanket `db push`
 * against a migrations directory that may have unrelated drift from remote
 * history (this repo has known drift: staging carries migrations whose .sql
 * files are not present on every branch).
 *
 * Node built-ins only.
 *
 * Usage (classification only, no network/CLI calls):
 *   node security/scripts/select-candidate-migrations.js <baseSha> <headSha>
 *
 * Requires SUPABASE_ACCESS_TOKEN in the environment and a project already
 * `supabase link`-ed when actually querying remote state (see
 * apply-candidate-migrations.js, which is the executing counterpart).
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join('supabase', 'migrations');
// Deliberately narrow: matches this repo's actual snake_case convention only
// (every existing migration filename fits this). A candidate's path and
// parsed name eventually reach `execFileSync(..., { shell: true })` on
// Windows dev machines (see apply-candidate-migrations.js) — restricting the
// character set here means a maliciously crafted filename (e.g. containing
// `$(...)`  or `;`) can never be classified as a valid candidate at all, so
// it never reaches an exec call regardless of shell mode.
const FILENAME_RE = /^(\d{14})_([a-zA-Z0-9_]+)\.sql$/;

const STATUS = {
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  NOT_YET_APPLIED: 'NOT_YET_APPLIED',
  MIGRATION_HISTORY_CONFLICT: 'MIGRATION_HISTORY_CONFLICT',
};

const OUTCOME = {
  APPLIED: 'APPLIED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  NO_CANDIDATE_MIGRATIONS: 'NO_CANDIDATE_MIGRATIONS',
  MIGRATION_HISTORY_CONFLICT: 'MIGRATION_HISTORY_CONFLICT',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
};

// Parses a migration filename into {version, name}. Returns null for anything
// that doesn't match <14-digit-version>_<name>.sql — those are excluded from
// the candidate list rather than failing the whole run, since a stray
// unrelated file under supabase/migrations/ should not block a PR.
function parseMigrationFilename(filename) {
  const base = path.basename(filename);
  const match = FILENAME_RE.exec(base);
  if (!match) return null;
  return { version: match[1], name: match[2] };
}

function gitDiffMigrationFiles(baseSha, headSha) {
  const out = execSync(`git diff --name-only ${baseSha}...${headSha} -- ${MIGRATIONS_DIR}/`, {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Builds the candidate list from the PR diff. Files that no longer exist at
// HEAD (deleted in the diff range) or that don't match the filename pattern
// are excluded, each with a reason recorded in `excluded` for auditability —
// nothing is silently dropped.
function getCandidateMigrationFiles(baseSha, headSha) {
  const changedFiles = gitDiffMigrationFiles(baseSha, headSha);
  const candidates = [];
  const excluded = [];

  for (const relPath of changedFiles) {
    const parsed = parseMigrationFilename(relPath);
    if (!parsed) {
      excluded.push({ path: relPath, reason: 'MALFORMED_FILENAME' });
      continue;
    }
    if (!fs.existsSync(relPath)) {
      excluded.push({ path: relPath, reason: 'NOT_PRESENT_AT_HEAD' });
      continue;
    }
    candidates.push({ version: parsed.version, name: parsed.name, path: relPath });
  }

  // Stable order: apply in version order regardless of git diff ordering.
  candidates.sort((a, b) => a.version.localeCompare(b.version));

  return { candidates, excluded };
}

// remoteMigrationRows: parsed `supabase migration list --linked --output-format json`
//   .migrations array — each row has {local, remote, time}.
// remoteNameByVersion: map of version -> name from
//   `select version, name from supabase_migrations.schema_migrations`.
function classifyCandidate(candidate, remoteMigrationRows, remoteNameByVersion) {
  const remoteName = remoteNameByVersion ? remoteNameByVersion[candidate.version] : undefined;
  if (remoteName !== undefined && remoteName !== candidate.name) {
    return { ...candidate, status: STATUS.MIGRATION_HISTORY_CONFLICT, remoteName };
  }

  const row = (remoteMigrationRows || []).find((r) => r.local === candidate.version);
  const isOnRemote = row ? row.remote === candidate.version : Boolean(remoteName);

  return {
    ...candidate,
    status: isOnRemote ? STATUS.ALREADY_APPLIED : STATUS.NOT_YET_APPLIED,
  };
}

function classifyCandidates(candidates, remoteMigrationRows, remoteNameByVersion) {
  return candidates.map((c) => classifyCandidate(c, remoteMigrationRows, remoteNameByVersion));
}

// Determines the overall run outcome from per-candidate statuses. Does not
// itself execute anything — see apply-candidate-migrations.js for that.
function deriveOutcome(classified) {
  if (classified.length === 0) return OUTCOME.NO_CANDIDATE_MIGRATIONS;
  if (classified.some((c) => c.status === STATUS.MIGRATION_HISTORY_CONFLICT)) {
    return OUTCOME.MIGRATION_HISTORY_CONFLICT;
  }
  if (classified.every((c) => c.status === STATUS.ALREADY_APPLIED)) {
    return OUTCOME.ALREADY_APPLIED;
  }
  return OUTCOME.APPLIED; // at least one NOT_YET_APPLIED — caller must execute it
}

// Flags candidates that share the same 14-digit version — a genuine anomaly
// (two files should never carry the same version prefix) distinct from a
// remote-history conflict. Returns the list of duplicated version strings.
function detectDuplicateVersions(candidates) {
  const seen = new Map();
  for (const c of candidates) {
    seen.set(c.version, (seen.get(c.version) || 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([version]) => version);
}

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

// Throws if the given project ref is the production project — the one
// guard every entry point into this module's executing counterpart must
// pass before doing anything network-facing.
function assertNotProductionRef(projectRef) {
  if (projectRef === PRODUCTION_REF) {
    throw new Error(`refused: production project ref (${PRODUCTION_REF})`);
  }
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!baseSha || !headSha) {
    console.error('Usage: select-candidate-migrations.js <baseSha> <headSha>');
    process.exit(2);
  }

  const { candidates, excluded } = getCandidateMigrationFiles(baseSha, headSha);
  const result = { baseSha, headSha, candidates, excluded };
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  STATUS,
  OUTCOME,
  PRODUCTION_REF,
  parseMigrationFilename,
  getCandidateMigrationFiles,
  classifyCandidate,
  classifyCandidates,
  deriveOutcome,
  detectDuplicateVersions,
  assertNotProductionRef,
};
