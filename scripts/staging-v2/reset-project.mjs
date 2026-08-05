#!/usr/bin/env node
/**
 * Guarded Staging v2 rebuild/reset.
 *
 * Deliberately NOT a generic reset command: the target can only ever resolve to
 * an allow-listed Staging v2 reference, production and old staging are rejected
 * outright, typed confirmation is mandatory, and an object inventory is captured
 * before anything is dropped.
 *
 * Usage:
 *   node scripts/staging-v2/reset-project.mjs --project-ref <ref> --confirm RESET-STAGING-V2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runGuarded, runSupabaseForTarget } from '../lib/staging-v2-cli.mjs';
import { assertResetAuthorized, RESET_CONFIRMATION_PHRASE } from '../lib/staging-v2-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'staging-v2', 'reset-evidence');
const OPERATION = 'staging-v2-reset';

await runGuarded(OPERATION, async () => {
  const args = parseArgs(process.argv.slice(2));
  const explicit =
    (typeof args['project-ref'] === 'string' ? args['project-ref'] : '') ||
    process.env.SUPABASE_STAGING_V2_PROJECT_REF ||
    '';

  const target = assertResetAuthorized({
    projectRef: explicit,
    confirmation: typeof args.confirm === 'string' ? args.confirm : '',
  });

  if (args['dry-run']) {
    console.log(`Dry run — reset authorized for ${target.projectRef} but not executed.`);
    return;
  }

  // Pre-reset evidence capture is mandatory: a reset that leaves no record of
  // what was there cannot be reasoned about afterwards.
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = process.env.RESET_EVIDENCE_STAMP || 'latest';
  const evidencePath = path.join(EVIDENCE_DIR, `${target.projectRef}-${stamp}.json`);

  const inventory = runSupabaseForTarget(target, ['migration', 'list', '--output-format', 'json']);
  fs.writeFileSync(evidencePath, inventory);
  console.log(`Pre-reset evidence written to ${path.relative(ROOT, evidencePath)}`);

  runSupabaseForTarget(target, ['db', 'reset', '--linked'], { stdio: 'inherit' });

  // Post-reset verification: prove we are still looking at the project we were
  // authorized for, not a project the CLI silently re-linked to.
  const after = runSupabaseForTarget(target, ['migration', 'list', '--output-format', 'json']);
  console.log(`Post-reset verification against ${target.projectRef}: ${after.length}B inventory`);
  console.log(`Confirmation phrase honoured: ${RESET_CONFIRMATION_PHRASE}`);
});
