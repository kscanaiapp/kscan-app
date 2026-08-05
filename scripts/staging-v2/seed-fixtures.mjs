#!/usr/bin/env node
/**
 * Guarded synthetic fixture seeding for Staging v2.
 *
 * Idempotent. Seeds ONLY synthetic data. Never copies production records and
 * never seeds Waitlist entries.
 *
 * Usage:
 *   node scripts/staging-v2/seed-fixtures.mjs --project-ref <ref> [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveCliTarget, runGuarded } from '../lib/staging-v2-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_FILE = path.join(ROOT, 'supabase', 'staging-v2', 'seed-synthetic.sql');
const OPERATION = 'staging-v2-seed-fixtures';

const FORBIDDEN_SEED_PATTERNS = [
  { id: 'WAITLIST_SEED', regex: /\binsert\s+into\s+[^\s;]*waitlist/i },
  { id: 'AUTH_USER_INSERT', regex: /\binsert\s+into\s+auth\.users\b/i },
];

await runGuarded(OPERATION, async () => {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveCliTarget(OPERATION, args);

  if (!fs.existsSync(SEED_FILE)) throw new Error(`Missing seed file: ${path.relative(ROOT, SEED_FILE)}`);
  const sql = fs.readFileSync(SEED_FILE, 'utf8');

  for (const rule of FORBIDDEN_SEED_PATTERNS) {
    if (rule.regex.test(sql)) {
      throw new Error(`Seed file violates ${rule.id}; refusing to run.`);
    }
  }

  console.log(`Target project: ${target.projectRef}`);
  console.log(`Seed file: ${path.relative(ROOT, SEED_FILE)} (${sql.length}B, synthetic only)`);

  if (args['dry-run']) {
    console.log('Dry run — nothing seeded.');
    return;
  }

  console.log(
    'Apply the seed with the Supabase SQL execution path bound to the guarded target above. ' +
      'The primary emulator test user is created through the real signup flow, never inserted.',
  );
});
