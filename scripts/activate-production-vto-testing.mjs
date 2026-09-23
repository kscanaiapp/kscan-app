#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  assertProductionTarget,
  missingRequiredProductionVars,
  PRODUCTION_PROJECT_REF,
  runSupabaseProduction,
} from './lib/production-helpers.mjs';
import {
  gitHeadSha,
  gitWorkingTreeClean,
  parseSupabaseRows,
} from './lib/staging-helpers.mjs';

const GOVERNED_BRANCH = process.env.GOVERNED_BRANCH || 'rebuild/backend-authority-v2';
const CONFIRM_PHRASE = 'ENABLE BUILD34 VTO LIVE TESTING';
const EXPECTED_PROVIDER = 'ailabtools_tryon_clothes_pro';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertGovernedCommit() {
  let remoteSha;
  try {
    execFileSync('git', ['fetch', 'origin', GOVERNED_BRANCH, '--quiet'], { encoding: 'utf8' });
    remoteSha = execFileSync('git', ['rev-parse', 'origin/' + GOVERNED_BRANCH], { encoding: 'utf8' }).trim();
  } catch (error) {
    fail('Could not resolve origin/' + GOVERNED_BRANCH + ': ' + error.message);
  }

  const head = gitHeadSha();
  if (!head || head !== remoteSha) {
    fail(
      'HEAD (' + (head || 'unresolved') + ') is not the current governed tip (' + remoteSha + '). ' +
      'Production configuration changes only run from the merged backend authority tip.',
    );
  }
  return head;
}

function queryRows(sql) {
  const stdout = runSupabaseProduction([
    'db',
    'query',
    sql,
    '--linked',
    '--output-format',
    'json',
  ]);
  const rows = parseSupabaseRows(stdout);
  if (rows === null) fail('Supabase CLI returned an unreadable JSON row shape');
  return rows;
}

function readConfigState() {
  const sql =
    "select key, value from public.app_config where key in ('vto_generation','watchlist_worker_enabled','account_deletion_worker_enabled','account_deletion_worker_dry_run','orphan_media_destructive_mode') order by key";
  const rows = queryRows(sql);
  return new Map(rows.map((row) => [String(row.key), row.value]));
}

function enabled(value) {
  return value && typeof value === 'object' && value.enabled === true;
}

function disabled(value) {
  return value && typeof value === 'object' && value.enabled === false;
}

function safeConfigSummary(state) {
  const vto = state.get('vto_generation') ?? null;
  return {
    vto: vto && typeof vto === 'object'
      ? { enabled: vto.enabled === true, provider: typeof vto.provider === 'string' ? vto.provider : null }
      : null,
    watchlistWorkerEnabled: enabled(state.get('watchlist_worker_enabled')),
    accountDeletionWorkerEnabled: enabled(state.get('account_deletion_worker_enabled')),
    accountDeletionDryRun: state.has('account_deletion_worker_dry_run')
      ? enabled(state.get('account_deletion_worker_dry_run'))
      : null,
    orphanMediaDestructiveMode: state.has('orphan_media_destructive_mode')
      ? enabled(state.get('orphan_media_destructive_mode'))
      : null,
  };
}

function requireContainment(state) {
  const watchlist = state.get('watchlist_worker_enabled');
  if (!watchlist || !disabled(watchlist)) {
    fail('watchlist_worker_enabled must exist and remain enabled=false during Build 34 live testing');
  }

  const deletion = state.get('account_deletion_worker_enabled');
  if (!deletion || !disabled(deletion)) {
    fail('account_deletion_worker_enabled must exist and remain enabled=false during Build 34 live testing');
  }

  if (state.has('account_deletion_worker_dry_run') && !enabled(state.get('account_deletion_worker_dry_run'))) {
    fail('account_deletion_worker_dry_run exists but is not enabled=true');
  }

  if (state.has('orphan_media_destructive_mode') && enabled(state.get('orphan_media_destructive_mode'))) {
    fail('orphan_media_destructive_mode is enabled; refusing VTO activation');
  }
}

function ledgerCount() {
  const rows = queryRows('select count(*)::int as ledger_count from supabase_migrations.schema_migrations');
  if (rows.length !== 1 || !Number.isInteger(Number(rows[0].ledger_count))) {
    fail('Could not read a single production migration ledger count');
  }
  return Number(rows[0].ledger_count);
}

function main() {
  if (process.env.CONFIRM_VTO_ACTIVATION !== CONFIRM_PHRASE) {
    fail('CONFIRM_VTO_ACTIVATION must be exactly "' + CONFIRM_PHRASE + '"');
  }

  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    fail('SUPABASE_ACCESS_TOKEN is absent');
  }

  const missing = missingRequiredProductionVars();
  if (missing.length) {
    fail('Missing required production variables: ' + missing.join(', '));
  }

  const identity = assertProductionTarget();
  if (!gitWorkingTreeClean()) {
    fail('Working tree is dirty; production configuration changes require a clean checkout');
  }
  const commit = assertGovernedCommit();

  runSupabaseProduction(['link', '--project-ref', PRODUCTION_PROJECT_REF, '--yes']);

  const beforeLedger = ledgerCount();
  const before = readConfigState();
  requireContainment(before);

  const vtoBefore = before.get('vto_generation');
  if (!vtoBefore || typeof vtoBefore !== 'object') {
    fail('app_config.vto_generation is missing or malformed');
  }

  const beforeProvider = typeof vtoBefore.provider === 'string' ? vtoBefore.provider : '';
  if (vtoBefore.enabled === true && beforeProvider !== EXPECTED_PROVIDER) {
    fail('VTO is already enabled with unexpected provider "' + beforeProvider + '"');
  }
  if (
    vtoBefore.enabled !== true &&
    beforeProvider !== 'mock' &&
    beforeProvider !== EXPECTED_PROVIDER
  ) {
    fail('VTO disabled state names unexpected provider "' + beforeProvider + '"');
  }

  let mutated = false;
  if (!(vtoBefore.enabled === true && beforeProvider === EXPECTED_PROVIDER)) {
    const updateSql =
      "update public.app_config set value = jsonb_set(jsonb_set(value, '{enabled}', 'true'::jsonb, true), '{provider}', to_jsonb('ailabtools_tryon_clothes_pro'::text), true) || jsonb_build_object('updatedAt', to_char((now() at time zone 'utc'), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) where key = 'vto_generation' returning key, value";
    const updated = queryRows(updateSql);
    if (updated.length !== 1 || String(updated[0].key) !== 'vto_generation') {
      fail('VTO activation update did not modify exactly the vto_generation row');
    }
    mutated = true;
  }

  const after = readConfigState();
  requireContainment(after);

  const vtoAfter = after.get('vto_generation');
  if (
    !vtoAfter ||
    typeof vtoAfter !== 'object' ||
    vtoAfter.enabled !== true ||
    vtoAfter.provider !== EXPECTED_PROVIDER
  ) {
    fail('VTO activation read-back does not match the governed live-testing posture');
  }

  const afterLedger = ledgerCount();
  if (afterLedger !== beforeLedger) {
    fail('Migration ledger changed during config-only activation (' + beforeLedger + ' -> ' + afterLedger + ')');
  }

  console.log(JSON.stringify({
    result: 'PASS',
    target: identity.projectRef,
    governedBranch: GOVERNED_BRANCH,
    governedSha: commit,
    mutated,
    migrationLedgerBefore: beforeLedger,
    migrationLedgerAfter: afterLedger,
    before: safeConfigSummary(before),
    after: safeConfigSummary(after),
  }, null, 2));
}

main();
