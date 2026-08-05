#!/usr/bin/env node
/**
 * Guarded Edge Function deployment for Staging v2.
 *
 * Usage:
 *   node scripts/staging-v2/deploy-function.mjs --project-ref <ref> --function <slug> [--no-verify-jwt] [--dry-run]
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveCliTarget, runGuarded, runSupabaseForTarget } from '../lib/staging-v2-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase', 'functions');
const OPERATION = 'staging-v2-deploy-function';

function hashFunctionSource(dir) {
  const hash = createHash('sha256');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hash.update(path.relative(dir, full).replace(/\\/g, '/'));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

await runGuarded(OPERATION, async () => {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveCliTarget(OPERATION, args);

  const slug = typeof args.function === 'string' ? args.function : '';
  if (!slug) throw new Error('--function <slug> is required');

  const dir = path.join(FUNCTIONS_DIR, slug);
  if (!fs.existsSync(dir)) throw new Error(`No such function directory: supabase/functions/${slug}`);

  const sourceHash = hashFunctionSource(dir);
  console.log(`Target project: ${target.projectRef}`);
  console.log(`Function: ${slug}`);
  console.log(`Source sha256: ${sourceHash}`);

  if (args['dry-run']) {
    console.log('Dry run — nothing deployed.');
    return;
  }

  const argv = ['functions', 'deploy', slug];
  if (args['no-verify-jwt']) argv.push('--no-verify-jwt');
  const out = runSupabaseForTarget(target, argv);
  process.stdout.write(out);
});
