#!/usr/bin/env node
'use strict';

/**
 * Compares live staging RPC EXECUTE grants against the reviewed access policy.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/verify-rpc-policy.js --state <observed-rpc-state.json>
 *   node security/scripts/verify-rpc-policy.js --state <file> --policy <file>
 *
 * Observed state shape:
 *   { project_ref, rpc_grants: [{ id, security_definer, search_path,
 *     anon_execute, authenticated_execute, service_role_execute }] }
 *
 * Fails closed: absent evidence is OPERATIONAL_FAILURE, never MATCH.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  CLASSIFICATIONS: C,
  PRODUCTION_REF,
  assertNotProduction,
  ProductionTargetError,
} = require('./verify-staging-parity');

const DEFAULT_POLICY = path.join('security', 'staging', 'rpc-access-policy.json');

function finding(id, classification, detail, extra) {
  return { domain: 'rpc_policy', id, classification, detail, ...(extra || {}) };
}

function compareRpcGrants({ policy, observed } = {}) {
  if (!policy || typeof policy !== 'object') {
    throw new Error('compareRpcGrants requires a policy object');
  }

  assertNotProduction(policy.staging_project_ref, 'policy.staging_project_ref');

  const findings = [];

  if (!observed || typeof observed !== 'object' || !Array.isArray(observed.rpc_grants)) {
    findings.push(finding('*', C.OPERATIONAL_FAILURE, 'no observed RPC grant evidence supplied'));
    return finalize(findings, policy);
  }

  assertNotProduction(observed.project_ref, 'observed.project_ref');

  const observedById = new Map(observed.rpc_grants.map((r) => [r.id, r]));
  const policyById = new Map(policy.functions.map((f) => [f.signature, f]));

  for (const fn of policy.functions) {
    const live = observedById.get(fn.signature);
    if (!live) {
      findings.push(finding(fn.signature, C.MISSING_LIVE_OBJECT, 'declared in policy but absent from live staging'));
      continue;
    }

    let drifted = false;
    const checks = [
      ['anon_execute', fn.expected_anon_execute, live.anon_execute],
      ['authenticated_execute', fn.expected_authenticated_execute, live.authenticated_execute],
      ['service_role_execute', fn.expected_service_role_execute, live.service_role_execute],
    ];

    for (const [field, expected, actual] of checks) {
      if (actual === undefined) {
        findings.push(finding(fn.signature, C.OPERATIONAL_FAILURE, `observed record missing field "${field}"`));
        drifted = true;
        continue;
      }
      if (expected === actual) continue;

      drifted = true;
      const granted = actual === true && expected === false;
      const anonSecDef = granted && field === 'anon_execute' && live.security_definer
        && fn.classification !== 'PUBLIC_INTENTIONAL';

      findings.push(finding(
        fn.signature,
        C.PRIVILEGE_DRIFT,
        granted
          ? `${field}: unexpected grant present (policy expects ${expected})`
          : `${field}: expected access missing (policy expects ${expected})`,
        {
          policyClassification: fn.classification,
          severity: fn.severity || (anonSecDef ? 'HIGH' : null),
          anonSecurityDefinerExposure: anonSecDef || undefined,
          missingExpectedAccess: (!granted) || undefined,
        },
      ));
    }

    // A pinned search_path must never regress to mutable.
    if (fn.search_path !== null && live.search_path === null) {
      findings.push(finding(fn.signature, C.CONFIGURATION_DRIFT, 'search_path regressed to mutable'));
      drifted = true;
    }

    if (!drifted) findings.push(finding(fn.signature, C.MATCH, 'live grants match policy'));
  }

  for (const live of observed.rpc_grants) {
    if (policyById.has(live.id)) continue;
    const reachable = live.anon_execute || live.authenticated_execute;
    findings.push(finding(
      live.id,
      C.UNTRACKED_LIVE_OBJECT,
      reachable
        ? 'client-reachable function is absent from the access policy'
        : 'function is absent from the access policy',
      {
        severity: live.anon_execute && live.security_definer ? 'HIGH' : null,
        anonSecurityDefinerExposure: (live.anon_execute && live.security_definer) || undefined,
      },
    ));
  }

  return finalize(findings, policy);
}

function finalize(findings, policy) {
  const byClassification = {};
  for (const key of Object.values(C)) byClassification[key] = 0;
  for (const f of findings) byClassification[f.classification] = (byClassification[f.classification] || 0) + 1;
  const blocking = findings.filter((f) => f.classification !== C.MATCH);
  return {
    ok: blocking.length === 0,
    stagingProjectRef: policy.staging_project_ref,
    findings,
    summary: {
      byClassification,
      blockingCount: blocking.length,
      anonSecurityDefinerExposures: findings.filter((f) => f.anonSecurityDefinerExposure).map((f) => f.id),
      blocking,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') args.state = argv[i + 1];
    if (argv[i] === '--policy') args.policy = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath = args.policy || DEFAULT_POLICY;

  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, classification: C.OPERATIONAL_FAILURE, detail: `unreadable policy ${policyPath}: ${error.message}` }));
    process.exit(1);
  }

  let observed = null;
  if (args.state) {
    try {
      observed = JSON.parse(fs.readFileSync(args.state, 'utf8'));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, classification: C.OPERATIONAL_FAILURE, detail: `unreadable state ${args.state}: ${error.message}` }));
      process.exit(1);
    }
  }

  let result;
  try {
    result = compareRpcGrants({ policy, observed });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, classification: error.code || 'OPERATIONAL_FAILURE', detail: error.message }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: result.ok,
    stagingProjectRef: result.stagingProjectRef,
    evidenceSupplied: Boolean(observed),
    summary: result.summary.byClassification,
    anonSecurityDefinerExposures: result.summary.anonSecurityDefinerExposures,
    blocking: result.summary.blocking,
  }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { compareRpcGrants, PRODUCTION_REF, ProductionTargetError, CLASSIFICATIONS: C };
