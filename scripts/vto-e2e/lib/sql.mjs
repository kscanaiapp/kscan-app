/**
 * THE single governed SQL execution venue for the VTO E2E harness (repair
 * spec §12/§14). Every module that needs privileged staging SQL — actor
 * provisioning, entitlement seeding, release-RPC calls, persistence/residual
 * verification, cleanup — imports `runSqlViaSupabaseCli` and `sqlQuote` from
 * here rather than shelling out or building SQL literals itself, so there is
 * exactly one place that knows how a statement reaches staging Postgres and
 * exactly one place that knows how a value is safely embedded in one.
 *
 * Reuses the repository's existing Supabase CLI/management path
 * (runSupabase -> `supabase db query <sql> --linked`, authenticated by the
 * already-governed SUPABASE_ACCESS_TOKEN, executed via the Management API)
 * rather than embedding a service-role key or opening a raw Postgres
 * connection in this harness. This is the exact mechanism
 * scripts/apply-staging-migration.mjs already uses successfully for staging
 * SQL — see scripts/lib/staging-helpers.mjs, which every other staging
 * deployment script in this repository already uses for exactly this
 * purpose. `supabase db query` is a real subcommand of the installed CLI
 * (confirmed: `supabase db query --help` lists it, and this exact
 * `[sql, '--linked', '--output-format', 'json']` argument shape is accepted
 * — verified against supabase CLI 2.116.0, the version `supabase/setup-cli@v1`
 * with `version: latest` currently resolves).
 */
'use strict';

import { runSupabase, parseSupabaseRows } from '../../lib/staging-helpers.mjs';

/**
 * Runs one SQL statement against the linked (staging) project and returns
 * its rows as a plain array. Throws if the CLI's output cannot be parsed —
 * an unreadable result must never be read as "zero rows" (the exact defect
 * PR #289 fixed in the migration applier).
 */
export function runSqlViaSupabaseCli(sql) {
  const out = runSupabase(['db', 'query', sql, '--linked', '--output-format', 'json']);
  const rows = parseSupabaseRows(out);
  if (rows === null) {
    throw new Error(`runSqlViaSupabaseCli: unparseable output for statement: ${sql.slice(0, 120)}...`);
  }
  return rows;
}

/**
 * Quotes one value as a single-quoted SQL string literal, doubling any
 * embedded single quote so the value can only ever be read as the CONTENTS
 * of one literal — never as SQL syntax that breaks out of it. This is the
 * one escaping function every SQL-construction call site in this harness
 * uses (previously duplicated per-file; consolidated here as part of the
 * single-SQL-venue repair so there is exactly one place to audit or fix).
 *
 * This harness only ever binds plain scalar identifiers (uuids, emails,
 * idempotency-key hex digests) this way — never table/column names — so
 * literal-quoting is the correct and sufficient defense; see the SQL
 * injection negative control in __tests__/vtoE2eHarnessIntegrity.test.js.
 */
export function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
