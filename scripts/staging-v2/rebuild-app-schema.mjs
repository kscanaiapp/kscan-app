#!/usr/bin/env node
/**
 * Guarded scoped rebuild of the K Scan AI Staging application schema.
 *
 * Deliberately NOT `supabase db reset` and NOT a generic reset tool:
 *   - the target can only ever resolve to the allow-listed staging reference;
 *   - production is rejected outright;
 *   - the Waitlist and website privacy tables are excluded from the drop set by
 *     construction AND re-checked statement-by-statement before execution;
 *   - a verified protected-table backup must exist first;
 *   - confirmation is typed and bound to the staging project reference.
 *
 * Usage:
 *   node scripts/staging-v2/rebuild-app-schema.mjs \
 *     --project-ref yzqjvdfgefveprobvvyw \
 *     --confirm REBUILD-yzqjvdfgefveprobvvyw \
 *     --backup docs/staging-v2/protected-backup/<file>.json \
 *     [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runGuarded } from '../lib/staging-v2-cli.mjs';
import {
  assertRebuildAuthorized,
  assertDoesNotTouchProtectedTables,
  PROTECTED_TABLES,
  RESET_CONFIRMATION_PHRASE,
} from '../lib/staging-v2-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPERATION = 'staging-scoped-rebuild';

/**
 * Verify the protected-table backup is present, well-formed, and non-empty for
 * every protected table that had rows at capture time.
 */
function verifyProtectedBackup(backupPath) {
  if (!backupPath) return { ok: false, reason: '--backup <file> is required' };
  const full = path.isAbsolute(backupPath) ? backupPath : path.join(ROOT, backupPath);
  if (!fs.existsSync(full)) return { ok: false, reason: `backup not found: ${backupPath}` };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `backup is not valid JSON: ${err.message}` };
  }

  for (const table of PROTECTED_TABLES) {
    const entry = parsed.tables && parsed.tables[table];
    if (!entry) return { ok: false, reason: `backup is missing ${table}` };
    if (typeof entry.rowCount !== 'number') {
      return { ok: false, reason: `backup for ${table} has no recorded rowCount` };
    }
    if (!Array.isArray(entry.rows) || entry.rows.length !== entry.rowCount) {
      return {
        ok: false,
        reason: `backup for ${table} holds ${Array.isArray(entry.rows) ? entry.rows.length : 'no'} rows but records rowCount=${entry.rowCount}`,
      };
    }
    if (!entry.ddl) return { ok: false, reason: `backup for ${table} has no captured DDL` };
  }
  return { ok: true, path: full, parsed };
}

await runGuarded(OPERATION, async () => {
  const args = parseArgs(process.argv.slice(2));
  const explicit =
    (typeof args['project-ref'] === 'string' ? args['project-ref'] : '') ||
    process.env.SUPABASE_STAGING_PROJECT_REF ||
    '';

  const backup = verifyProtectedBackup(typeof args.backup === 'string' ? args.backup : '');

  const target = assertRebuildAuthorized({
    projectRef: explicit,
    confirmation: typeof args.confirm === 'string' ? args.confirm : '',
    protectedBackupVerified: backup.ok,
  });

  if (!backup.ok) {
    // Unreachable while the guard enforces protectedBackupVerified, but kept so
    // the operator sees *why* the backup was judged unusable.
    throw new Error(`Protected-table backup rejected: ${backup.reason}`);
  }

  const planPath = typeof args.plan === 'string' ? args.plan : 'supabase/staging-v2/rebuild-plan.sql';
  const planFull = path.isAbsolute(planPath) ? planPath : path.join(ROOT, planPath);
  if (!fs.existsSync(planFull)) throw new Error(`Missing rebuild plan: ${planPath}`);
  const planSql = fs.readFileSync(planFull, 'utf8');

  // Statement-level protection: even a correctly targeted rebuild may not touch
  // the Waitlist or website privacy tables.
  assertDoesNotTouchProtectedTables(planSql, { operation: OPERATION });

  console.log('─'.repeat(64));
  console.log('Target project name: K Scan AI Staging');
  console.log(`Target project ref:  ${target.projectRef}`);
  console.log(`Target project URL:  ${target.url}`);
  console.log('Production project rejected: Yes');
  console.log(`Protected tables preserved: ${PROTECTED_TABLES.join(', ')}`);
  for (const table of PROTECTED_TABLES) {
    console.log(`  ${table}: ${backup.parsed.tables[table].rowCount} rows backed up`);
  }
  console.log(`Backup file: ${path.relative(ROOT, backup.path)}`);
  console.log(`Rebuild plan: ${planPath} (${planSql.length}B)`);
  console.log(`Confirmation honoured: ${RESET_CONFIRMATION_PHRASE}`);
  console.log('─'.repeat(64));

  if (args['dry-run']) {
    console.log('Dry run — staging unchanged.');
    return;
  }

  console.log(
    'Execute the validated plan through the guarded migration path ' +
      '(scripts/staging-v2/apply-migrations.mjs) against the target above.',
  );
});

export { verifyProtectedBackup };
