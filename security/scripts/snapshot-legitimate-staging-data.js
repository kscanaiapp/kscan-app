#!/usr/bin/env node
'use strict';

/**
 * Snapshots row counts for the legitimate, retained staging tables (waitlist,
 * privacy, deletion-request data) via `supabase db query`, so a before/after
 * diff around a deploy can show whether anything outside the deploy's own
 * scope was touched. Counts only — never selects row content.
 *
 * Usage:
 *   node security/scripts/snapshot-legitimate-staging-data.js <projectRef>
 */

const { execFileSync } = require('node:child_process');
const { assertNotProductionRef } = require('./select-candidate-migrations');

const LEGITIMATE_TABLES = [
  'waitlist_signups',
  'privacy_settings',
  'deletion_requests',
  'website_sale_share_opt_out_requests',
  'profiles',
  'privacy_export_requests',
  'privacy_correction_requests',
];

function buildCountQuery(tables) {
  return tables
    .map((t) => `select '${t}' as table_name, count(*) as row_count from public.${t}`)
    .join('\nunion all\n');
}

function snapshot(projectRef) {
  assertNotProductionRef(projectRef);
  const sql = buildCountQuery(LEGITIMATE_TABLES);
  // --linked and --project-ref are mutually exclusive on `db query`; --linked
  // alone resolves to whatever the workflow's prior `supabase link` step linked.
  const out = execFileSync('supabase', ['db', 'query', sql, '--linked', '--output-format', 'json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(out);
  const counts = {};
  for (const row of parsed.rows || []) {
    counts[row.table_name] = Number(row.row_count);
  }
  return counts;
}

function diffSnapshots(before, after) {
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const rows = tables.map((t) => ({
    table: t,
    before: before[t] ?? null,
    after: after[t] ?? null,
    changed: (before[t] ?? null) !== (after[t] ?? null),
  }));
  return { rows, anyChanged: rows.some((r) => r.changed) };
}

function main() {
  const [projectRef] = process.argv.slice(2);
  if (!projectRef) {
    console.error('Usage: snapshot-legitimate-staging-data.js <projectRef>');
    process.exit(2);
  }
  console.log(JSON.stringify(snapshot(projectRef), null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { LEGITIMATE_TABLES, buildCountQuery, diffSnapshots };
