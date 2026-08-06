#!/usr/bin/env node
'use strict';

/**
 * Orchestrates the live staging RLS/grant/Storage verification (Phase 3):
 * collects live metadata (query-staging-metadata.js) and evaluates it with
 * the existing, already-unit-tested pure guard functions
 * (anon-grant-guard.js, rls-storage-guard.js) rather than duplicating their
 * logic. This is the piece that was missing -- the guards always existed,
 * they just had no live data source in CI.
 *
 * Usage:
 *   node security/scripts/verify-live-staging-security.js \
 *     --project-ref <ref> [--timeout-ms 8000] [--json <outputFile>]
 *
 * Exit code: 0 if PASS or NOT_CONFIGURED (a missing credential is reportable,
 * not this script's failure), 1 for FAIL/BLOCKED/OPERATIONAL_FAILURE.
 */

const fs = require('node:fs');
const path = require('node:path');

const { queryStagingMetadata } = require('./query-staging-metadata');
const { detectUnintendedAnonGrants, detectStaleAllowlistEntries, ANON_EXECUTE_ALLOWLIST } = require('./anon-grant-guard');
const { detectUnexpectedAuthenticatedGrants, SERVICE_ROLE_ONLY_FUNCTIONS } = require('./authenticated-grant-guard');
const {
  detectTablesWithoutRls,
  detectUnexpectedPublicBuckets,
  detectPublicBucketsWithoutUploadControls,
  detectDefinerFunctionsWithoutSearchPath,
  PUBLIC_BUCKET_ALLOWLIST,
} = require('./rls-storage-guard');

function evaluate(metadata) {
  const unintendedAnonGrants = detectUnintendedAnonGrants(metadata.grants);
  const staleAllowlistEntries = detectStaleAllowlistEntries(metadata.grants);
  const unexpectedAuthenticatedGrants = detectUnexpectedAuthenticatedGrants(metadata.grants);
  const tablesWithoutRls = detectTablesWithoutRls(metadata.tables);
  const unexpectedPublicBuckets = detectUnexpectedPublicBuckets(metadata.buckets);
  const publicBucketsWithoutUploadControls = detectPublicBucketsWithoutUploadControls(metadata.buckets);
  const definerFunctionsWithoutSearchPath = detectDefinerFunctionsWithoutSearchPath(metadata.definerFunctions);
  const verdictWriteGrants = (metadata.verdictWriteGrants || []).map((g) => `${g.grantee}:${g.privilege_type}`);

  const findings = {
    rls: {
      status: tablesWithoutRls.length === 0 ? 'PASS' : 'FAIL',
      tablesWithoutRls,
    },
    anonGrants: {
      status: unintendedAnonGrants.length === 0 ? 'PASS' : 'FAIL',
      unintendedAnonGrants,
      staleAllowlistEntries, // informational, does not fail the check
      allowlist: ANON_EXECUTE_ALLOWLIST,
    },
    serviceRoleOnlyGrants: {
      status: unexpectedAuthenticatedGrants.length === 0 ? 'PASS' : 'FAIL',
      unexpectedAuthenticatedGrants,
      denylist: SERVICE_ROLE_ONLY_FUNCTIONS,
    },
    securityDefiner: {
      status: definerFunctionsWithoutSearchPath.length === 0 ? 'PASS' : 'FAIL',
      definerFunctionsWithoutSearchPath,
    },
    storage: {
      status: (unexpectedPublicBuckets.length === 0 && publicBucketsWithoutUploadControls.length === 0) ? 'PASS' : 'FAIL',
      unexpectedPublicBuckets,
      publicBucketsWithoutUploadControls,
      allowlist: PUBLIC_BUCKET_ALLOWLIST,
    },
    verdictWriteProtection: {
      status: verdictWriteGrants.length === 0 ? 'PASS' : 'FAIL',
      unexpectedGrants: verdictWriteGrants,
    },
  };

  const overall = Object.values(findings).every((f) => f.status === 'PASS') ? 'PASS' : 'FAIL';

  return { overall, findings };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-ref') out.projectRef = argv[++i];
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (argv[i] === '--json') out.jsonOut = argv[++i];
  }
  return out;
}

async function main() {
  const { projectRef, timeoutMs, jsonOut } = parseArgs(process.argv.slice(2));

  const metadata = await queryStagingMetadata({
    projectRef,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    timeoutMs,
  });

  let report;
  if (metadata.status !== 'COLLECTED') {
    report = {
      overall: metadata.status,
      reason: metadata.reason,
      findings: {
        rls: { status: metadata.status },
        anonGrants: { status: metadata.status },
        serviceRoleOnlyGrants: { status: metadata.status },
        securityDefiner: { status: metadata.status },
        storage: { status: metadata.status },
        verdictWriteProtection: { status: metadata.status },
      },
    };
  } else {
    report = evaluate(metadata);
  }

  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));

  // Only a real, verified PASS gives this check-run a passing conclusion --
  // NOT_CONFIGURED/BLOCKED/OPERATIONAL_FAILURE/FAIL must all register as
  // non-passing so evaluate-promotion-gate.js and the evidence bundle can't
  // mistake "unverified" for "verified secure" (Phase 8: "NOT_CONFIGURED
  // blocks when the dimension is required"). The granular status survives
  // in the JSON artifact for the evidence bundle to read directly.
  process.exit(report.overall === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { evaluate };
