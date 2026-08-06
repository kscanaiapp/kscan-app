#!/usr/bin/env node
'use strict';

/**
 * Live staging RLS/grant/Storage metadata collector (Phase 3). Uses the
 * Supabase Management API's SQL endpoint with the repo's EXISTING
 * SUPABASE_ACCESS_TOKEN secret -- no new database-connection credential is
 * required (this is "Preferred credential order: 2. Existing Supabase
 * management or CLI access capable of retrieving the required metadata
 * safely" from the task brief). Every query is a hardcoded, reviewed
 * read-only SELECT against pg_catalog/information_schema/storage.buckets --
 * this script never accepts or forwards caller-supplied SQL.
 *
 * Every query runs wrapped in an explicit read-only transaction with a
 * short statement timeout:
 *   BEGIN READ ONLY; SET LOCAL statement_timeout = '5000ms'; <select>; COMMIT;
 *
 * Verdict classification (never silently reports PASS for an unverifiable
 * state):
 *   NOT_CONFIGURED     -- no access token available at all
 *   BLOCKED            -- project ref resolves to production, or is not the
 *                         expected staging ref
 *   OPERATIONAL_FAILURE -- token present but rejected, query failed, or the
 *                         request timed out/network-errored
 *   (on success) the raw metadata is returned for the guard scripts to
 *   evaluate into PASS/FAIL findings.
 *
 * Usage:
 *   node security/scripts/query-staging-metadata.js --project-ref <ref> [--timeout-ms 8000]
 * Reads the token from SUPABASE_ACCESS_TOKEN — never accepts it as a CLI arg
 * (would leak into process listings / shell history).
 */

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const MANAGEMENT_API_BASE = 'https://api.supabase.com/v1';
const DEFAULT_TIMEOUT_MS = 8000;

const QUERIES = {
  tables: `
    select relname as "tableName", relrowsecurity as "rlsEnabled"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by relname;
  `,
  grants: `
    select p.proname as "functionName",
           has_function_privilege('anon', p.oid, 'EXECUTE') as "anonCanExecute",
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as "authenticatedCanExecute"
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by p.proname;
  `,
  definerFunctions: `
    select p.proname as "functionName",
           p.prosecdef as "securityDefiner",
           (select cfg from unnest(p.proconfig) cfg where cfg like 'search_path=%' limit 1) as "searchPathSetting"
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
    order by p.proname;
  `,
  buckets: `
    select name, public, file_size_limit as "fileSizeLimit", allowed_mime_types as "allowedMimeTypes"
    from storage.buckets
    order by name;
  `,
  // client roles cannot write security-controlled verdicts: image_scan_verdicts
  // must have no INSERT/UPDATE grant for anon or authenticated -- only
  // service_role (which bypasses grants) should ever write a verdict.
  verdictWriteGrants: `
    select grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'image_scan_verdicts'
      and privilege_type in ('INSERT', 'UPDATE')
      and grantee in ('anon', 'authenticated')
    order by grantee, privilege_type;
  `,
};

function wrapReadOnly(sql, timeoutMs) {
  return `begin read only; set local statement_timeout = '${Math.max(1000, timeoutMs)}ms'; ${sql} commit;`;
}

function classifyTargetRef(projectRef) {
  if (!projectRef) return { ok: false, status: 'BLOCKED', reason: 'no project ref supplied' };
  if (projectRef === PRODUCTION_PROJECT_REF) {
    return { ok: false, status: 'BLOCKED', reason: 'refusing to query the production project ref' };
  }
  if (projectRef !== STAGING_PROJECT_REF) {
    return { ok: false, status: 'BLOCKED', reason: `unrecognized project ref (expected ${STAGING_PROJECT_REF})` };
  }
  return { ok: true };
}

function redact(message) {
  // Never let a token or bearer value escape into a report even if an error
  // body happens to echo request context.
  return String(message).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

async function runManagementQuery({ projectRef, accessToken, sql, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${MANAGEMENT_API_BASE}/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: wrapReadOnly(sql, timeoutMs) }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      const err = new Error(`credential rejected (${res.status}): ${redact(body).slice(0, 200)}`);
      err.classification = 'MALFORMED_CREDENTIAL';
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`query failed (${res.status}): ${redact(body).slice(0, 200)}`);
      err.classification = 'QUERY_FAILURE';
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`request timed out after ${timeoutMs}ms`);
      timeoutErr.classification = 'TIMEOUT';
      throw timeoutErr;
    }
    if (!err.classification) err.classification = 'QUERY_FAILURE';
    err.message = redact(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function queryStagingMetadata({ projectRef, accessToken, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  if (!accessToken) {
    return { status: 'NOT_CONFIGURED', reason: 'SUPABASE_ACCESS_TOKEN is not set' };
  }

  const targetCheck = classifyTargetRef(projectRef);
  if (!targetCheck.ok) {
    return { status: targetCheck.status, reason: targetCheck.reason };
  }

  const results = {};
  for (const [key, sql] of Object.entries(QUERIES)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results[key] = await runManagementQuery({ projectRef, accessToken, sql, timeoutMs, fetchImpl });
    } catch (err) {
      return {
        status: 'OPERATIONAL_FAILURE',
        reason: `metadata query "${key}" failed: ${err.message}`,
        classification: err.classification || 'QUERY_FAILURE',
      };
    }
  }

  return {
    status: 'COLLECTED',
    projectRef,
    tables: results.tables,
    grants: results.grants,
    definerFunctions: results.definerFunctions,
    buckets: results.buckets,
    verdictWriteGrants: results.verdictWriteGrants,
  };
}

function parseArgs(argv) {
  const out = { timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-ref') out.projectRef = argv[++i];
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const { projectRef, timeoutMs } = parseArgs(process.argv.slice(2));
  const result = await queryStagingMetadata({
    projectRef,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    timeoutMs,
  });
  console.log(JSON.stringify(result));
  if (result.status === 'NOT_CONFIGURED') process.exit(0); // reportable, not a script failure
  if (result.status !== 'COLLECTED') process.exit(1);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  queryStagingMetadata,
  classifyTargetRef,
  wrapReadOnly,
  redact,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  QUERIES,
};
