#!/usr/bin/env node
/**
 * Migration version collision guard (CI-MIG-01, Build 34 migration
 * governance repair).
 *
 * Fails when two active, executable migration files under
 * supabase/migrations/ share the same leading numeric version -- the
 * condition that makes replay order against `supabase db push` ambiguous
 * (the CLI reconciles by filename version prefix, not content; see
 * scripts/verify-migration-authority.js and
 * docs/staging-rebuild/recovered-migrations/CENTRAL_MIGRATION_AUTHORITY.md).
 *
 * Source-based, no remote dependency. Never touches the database, the
 * Supabase CLI, or any migration file. Exits 1 and prints every violation
 * found (does not stop at the first one) if any check fails; exits 0
 * silently on success.
 */
const fs = require('fs');
const path = require('path');

const VERSION_PREFIX = /^(\d+)_.+\.sql$/;

/**
 * @param {string} migrationsDir absolute path to a supabase/migrations/ tree
 * @returns {string[]} violation messages, empty array means clean
 */
function findVersionCollisions(migrationsDir) {
  const violations = [];

  if (!fs.existsSync(migrationsDir)) {
    return [`Migrations directory does not exist: ${migrationsDir}`];
  }

  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  const byVersion = new Map(); // version string -> [filenames]

  for (const filename of files) {
    const match = filename.match(VERSION_PREFIX);
    if (!match) {
      violations.push(
        `Malformed active migration filename (no leading "<digits>_" version prefix): ${filename}`,
      );
      continue;
    }
    const version = match[1];
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(filename);
  }

  for (const [version, filenames] of byVersion) {
    if (filenames.length < 2) continue;
    violations.push(
      `Duplicate active migration version "${version}": ${filenames.join(', ')} -- ` +
        'supabase db push reconciles by filename version prefix, so two files sharing one ' +
        'makes replay order ambiguous. Rename one to its true applied ledger version (see ' +
        'config/migration-authority-manifest.json for the established convention) or declare ' +
        'it a historical alias.',
    );
  }

  return violations;
}

module.exports = { findVersionCollisions, VERSION_PREFIX };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  // Optional argv[2] override (a full supabase/migrations/ directory path)
  // for local/test use against a disposable fixture. Defaults to this repo's
  // own tree, which is what governed CI always invokes.
  const migrationsDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repoRoot, 'supabase', 'migrations');
  const violations = findVersionCollisions(migrationsDir);
  if (violations.length > 0) {
    console.error(`MIGRATION VERSION COLLISION GUARD: FAIL (${violations.length} violation(s))`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('MIGRATION VERSION COLLISION GUARD: PASS (no duplicate active version prefixes)');
}
