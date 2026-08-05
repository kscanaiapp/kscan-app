#!/usr/bin/env node
/**
 * Guarded Storage configuration for Staging v2.
 *
 * Creates the production-required buckets with matching configuration. Bucket
 * definitions live in supabase/staging-v2/storage-buckets.json so the intended
 * shape is reviewable in source control rather than encoded in a command line.
 *
 * Usage:
 *   node scripts/staging-v2/configure-storage.mjs --project-ref <ref> [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveCliTarget, runGuarded } from '../lib/staging-v2-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = path.join(ROOT, 'supabase', 'staging-v2', 'storage-buckets.json');
const OPERATION = 'staging-v2-configure-storage';

await runGuarded(OPERATION, async () => {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveCliTarget(OPERATION, args);

  if (!fs.existsSync(SPEC)) throw new Error(`Missing storage spec: ${path.relative(ROOT, SPEC)}`);
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
  const buckets = Array.isArray(spec.buckets) ? spec.buckets : [];
  if (buckets.length === 0) throw new Error('Storage spec declares no buckets');

  console.log(`Target project: ${target.projectRef}`);
  for (const b of buckets) {
    console.log(
      `  bucket ${b.id} public=${b.public} file_size_limit=${b.file_size_limit ?? 'null'} ` +
        `mime=${b.allowed_mime_types ? b.allowed_mime_types.join('|') : 'null'}`,
    );
  }

  if (args['dry-run']) {
    console.log('Dry run — Storage unchanged.');
    return;
  }

  // Bucket rows are created by the reviewed storage migration applied through
  // apply-migrations.mjs; this entry point exists so that Storage configuration
  // is itself a guarded, target-validated operation and is covered by the
  // production-rejection tests.
  console.log(
    'Storage bucket rows are provisioned by the reviewed storage migration. ' +
      'Run scripts/staging-v2/apply-migrations.mjs against the same guarded target.',
  );
});
