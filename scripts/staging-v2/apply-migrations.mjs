#!/usr/bin/env node
/**
 * Guarded migration application for Staging v2.
 *
 * Applies the reviewed baseline (and any forward-only deltas) through the normal
 * Supabase migration mechanism, so `supabase_migrations.schema_migrations` is
 * written by the tool rather than hand-edited.
 *
 * Usage:
 *   node scripts/staging-v2/apply-migrations.mjs --project-ref <ref> [--dry-run]
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveCliTarget, runGuarded, runSupabaseLinkedTo } from '../lib/staging-v2-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const OPERATION = 'staging-v2-apply-migrations';

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const full = path.join(MIGRATIONS_DIR, file);
      const body = fs.readFileSync(full);
      return {
        file,
        version: file.split('_')[0],
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
      };
    });
}

await runGuarded(OPERATION, async () => {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveCliTarget(OPERATION, args);

  const migrations = listMigrations();
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  console.log(`Target project: ${target.projectRef}`);
  console.log(`Migrations in source control: ${migrations.length}`);
  for (const m of migrations) {
    console.log(`  ${m.version}  ${m.file}  sha256=${m.sha256.slice(0, 16)}…  ${m.bytes}B`);
  }

  if (args['dry-run']) {
    console.log('Dry run — no migration applied.');
    return;
  }

  // `db push` is the migration-history-aware application path, and it is the only
  // Supabase command here with no --project-ref flag, so it runs through
  // runSupabaseLinkedTo: the link is forced to the guarded target and read back
  // and verified before the push, rather than the target being inferred from
  // whatever the project happened to be linked to.
  //
  // --include-all is required and is NOT a blanket push. Staging's applied
  // history interleaves with the production lineage (its Waitlist, provider-
  // security and legal-acceptance rows carry versions newer than production
  // migrations that staging never received), so the pending set is legitimately
  // out of order and the CLI skips such files without it. The set being applied
  // is still fully enumerated and hashed above, and the target is allow-listed.
  const out = runSupabaseLinkedTo(target, ['db', 'push', '--include-all', '--yes'], {
    root: ROOT,
    stdio: 'inherit',
  });
  if (out) process.stdout.write(out);
  console.log(`Applied through migration tooling against ${target.projectRef}.`);
});
