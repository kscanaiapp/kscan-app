#!/usr/bin/env node
/**
 * Wraps supabase/tests/kplus_entitlement_authority_test.sql into ONE batch for
 * a single rolled-back execution against a remote Supabase project, for when
 * no local stack is available to run `supabase test db`.
 *
 * The batch is one implicit transaction that always ends in a raised
 * exception, so nothing persists -- not the fixtures, and not the migration
 * when one is prefixed. The TAP totals and every failing assertion come back
 * in that exception's message:
 *
 *   KPLUS_TAP total=<n> failed=<n> <failing assertion lines>
 *
 * Usage:
 *   node scripts/kplus/build-entitlement-authority-sql-batch.mjs <out.sql> [prefix.sql ...]
 *
 * Prefix the migration to validate it BEFORE it is applied anywhere; omit it to
 * validate a project where it is already applied. Execute the output with a
 * shell-free, absolute-path invocation, for example:
 *
 *   supabase db query --linked --workdir <repo> -f <absolute out.sql>
 *
 * Confirm the linked project ref first; never point this at production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_FILE = path.join(ROOT, 'supabase', 'tests', 'kplus_entitlement_authority_test.sql');
const ASSERTIONS = /^select (ok|is|isnt|throws_ok|lives_ok|results_eq|set_eq|bag_eq|matches|cmp_ok)\(/;

const [outPath, ...prefixPaths] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: build-entitlement-authority-sql-batch.mjs <out.sql> [prefix.sql ...]');
  process.exit(2);
}

const lines = fs.readFileSync(TEST_FILE, 'utf8').split(/\r?\n/);
const out = prefixPaths.map((prefix) => fs.readFileSync(prefix, 'utf8'));

let sawPlan = false;
for (const line of lines) {
  if (/^begin;\s*$/.test(line) || /^rollback;\s*$/.test(line) || /^select \* from finish\(\);\s*$/.test(line)) continue;
  if (/^select no_plan\(\);\s*$/.test(line)) {
    out.push(line, 'create temp table _tap (n serial, line text);', 'grant all on table _tap to public;',
      'grant all on sequence _tap_n_seq to public;');
    sawPlan = true;
    continue;
  }
  out.push(ASSERTIONS.test(line) ? `insert into _tap(line) ${line}` : line);
}
if (!sawPlan) throw new Error('the test file has no `select no_plan();` line');

out.push(`do $tapfinal$
declare v_total int; v_failed int; v_detail text;
begin
  select count(*), count(*) filter (where line like 'not ok%'),
         string_agg(line, E'\\n' order by n) filter (where line like 'not ok%')
    into v_total, v_failed, v_detail from _tap;
  raise exception 'KPLUS_TAP total=% failed=% %', v_total, v_failed, coalesce(v_detail, '');
end $tapfinal$;`);

fs.writeFileSync(outPath, out.join('\n'));
console.log(`wrote ${outPath}: ${lines.filter((l) => ASSERTIONS.test(l)).length} assertions`);
