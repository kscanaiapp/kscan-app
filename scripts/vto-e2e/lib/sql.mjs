/**
 * Governed privileged-SQL execution for the VTO E2E harness.
 *
 * Reuses the repository's existing Supabase CLI/management path
 * (runSupabase -> `supabase db query --linked`, authenticated by the
 * already-governed SUPABASE_ACCESS_TOKEN) rather than embedding a
 * service-role key in this harness. See scripts/lib/staging-helpers.mjs,
 * which every other staging deployment script in this repository already
 * uses for exactly this purpose.
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
