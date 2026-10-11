#!/usr/bin/env node
/** Fetch private recovery on a fresh protected runner. Never print the package. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { managedRecoveryStore, unpackRecovery } from './lib/production-recovery.mjs';
import { assertProductionTarget } from './lib/production-helpers.mjs';
import { ensureArtifactsDir, writeJsonArtifact } from './lib/staging-helpers.mjs';

export async function recover(reference, { store, destination, rollback } = {}) {
  const bytes = await store.download(reference);
  const recovered = unpackRecovery(bytes, destination, reference);
  await rollback(recovered.manifestPath);
  return { ok: true, restored: true, source_commit: reference.source_commit };
}

async function main() {
  assertProductionTarget();
  const arg = process.argv.indexOf('--reference');
  const store = await managedRecoveryStore({ token: process.env.SUPABASE_ACCESS_TOKEN,
    anonKey: process.env.SUPABASE_PRODUCTION_ANON_KEY });
  const readArg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
  const reference = arg >= 0 && process.argv[arg + 1]
    ? JSON.parse(fs.readFileSync(process.argv[arg + 1], 'utf8'))
    : await store.readReference({ runId: readArg('--run-id'), attempt: readArg('--run-attempt'), sourceCommit: readArg('--source-commit') });
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-private-recovery-'));
  try {
    const result = await recover(reference, {
      store, destination,
      rollback: (manifestPath) => execFileSync(process.execPath,
        [path.join('scripts', 'rollback-production-function.mjs'), '--manifest', manifestPath],
        { encoding: 'utf8', env: process.env, stdio: 'inherit' }),
    });
    console.log(JSON.stringify(result));
  } finally { fs.rmSync(destination, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  writeJsonArtifact(path.join(ensureArtifactsDir('production-rollbacks'), 'critical-recovery-failure.json'), {
    ok: false, critical_recovery_failure: true, timestamp: new Date().toISOString(),
    next_action: 'Stop promotions; inspect protected Storage availability and recovery reference',
  });
  console.error('CRITICAL: private recovery failed. Stop promotions; inspect protected Storage availability and recovery reference.');
  process.exitCode = 1;
});
