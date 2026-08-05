#!/usr/bin/env node
/**
 * Standalone linked-project safety check.
 *
 * Exists because several Supabase CLI database commands (`db push`, `db dump`,
 * `db reset`, `migration list`) accept no `--project-ref` and silently act on
 * whatever project the working directory is linked to. A stale link is therefore
 * an execution hazard on its own, independent of any argument a caller passes.
 *
 * Run it directly, from a git hook, or from CI:
 *
 *   node scripts/staging-v2/check-linked-project.mjs            # this directory
 *   node scripts/staging-v2/check-linked-project.mjs --all      # every git worktree
 *
 * Exit codes: 0 safe, 2 refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertLinkedProjectSafe,
  readLinkedProjectRef,
  TargetRejectedError,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
} from '../lib/staging-v2-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function listWorktrees() {
  const out = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (out.status !== 0) return [ROOT];
  return out.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
}

const all = process.argv.includes('--all');
const targets = all ? listWorktrees() : [process.cwd()];

let refused = 0;
for (const dir of targets) {
  if (!fs.existsSync(dir)) continue;
  const linked = readLinkedProjectRef(dir);
  try {
    const result = assertLinkedProjectSafe({ root: dir, operation: 'check-linked-project' });
    const label = result.state === 'UNLINKED' ? 'unlinked (safe)' : `${result.linked} (staging)`;
    console.log(`OK       ${dir} -> ${label}`);
  } catch (err) {
    refused += 1;
    if (err instanceof TargetRejectedError) {
      console.error(`REFUSED  ${dir} -> ${linked}  [${err.code}]`);
    } else {
      console.error(`ERROR    ${dir}: ${err.message}`);
    }
  }
}

if (refused > 0) {
  console.error('');
  console.error(`${refused} director${refused === 1 ? 'y is' : 'ies are'} linked to a project that may not be written.`);
  console.error(`Production is ${PRODUCTION_PROJECT_REF}; the only writable project is ${STAGING_PROJECT_REF}.`);
  console.error('Fix by removing supabase/.temp/project-ref in the offending directory.');
  process.exit(2);
}

console.log(`\nAll ${targets.length} checked director${targets.length === 1 ? 'y' : 'ies'} safe.`);
