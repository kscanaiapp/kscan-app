#!/usr/bin/env node
'use strict';

/**
 * Compares the authoritative staging-state manifest against observed live staging state.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/verify-staging-parity.js --state <observed-state.json>
 *   node security/scripts/verify-staging-parity.js --state <file> --manifest <file>
 *
 * Fails closed: absent evidence is reported as OPERATIONAL_FAILURE, never MATCH.
 */

const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const DEFAULT_STAGING_REF = 'yzqjvdfgefveprobvvyw';
const DEFAULT_MANIFEST = path.join('security', 'staging', 'staging-state-manifest.json');

const C = Object.freeze({
  MATCH: 'MATCH',
  EXPECTED_EXCEPTION: 'EXPECTED_EXCEPTION',
  UNTRACKED_LIVE_OBJECT: 'UNTRACKED_LIVE_OBJECT',
  MISSING_LIVE_OBJECT: 'MISSING_LIVE_OBJECT',
  SOURCE_HASH_MISMATCH: 'SOURCE_HASH_MISMATCH',
  PRIVILEGE_DRIFT: 'PRIVILEGE_DRIFT',
  CONFIGURATION_DRIFT: 'CONFIGURATION_DRIFT',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
});

const NON_BLOCKING = new Set([C.MATCH, C.EXPECTED_EXCEPTION]);

const DOMAINS = Object.freeze(['migrations', 'tables', 'rls', 'rpc_grants', 'storage', 'edge_functions']);

class ProductionTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductionTargetError';
    this.code = 'PRODUCTION_TARGET_DETECTED';
  }
}

function assertNotProduction(ref, label) {
  if (!ref) return;
  if (String(ref).trim() === PRODUCTION_REF) {
    throw new ProductionTargetError(
      `PRODUCTION_TARGET_DETECTED: ${label} resolves to production ref ${PRODUCTION_REF}`,
    );
  }
}

function finding(domain, id, classification, detail, extra) {
  return { domain, id, classification, detail, ...(extra || {}) };
}

function exceptionFor(manifest, domain, id) {
  const list = Array.isArray(manifest.known_exceptions) ? manifest.known_exceptions : [];
  return list.find((e) => e && e.domain === domain && e.id === id) || null;
}

/**
 * Generic expected-vs-observed reconciliation for one manifest domain.
 * `fields` maps a compared property name to the classification its mismatch produces.
 */
function diffCollection({ domain, expected, observed, fields, manifest, findings }) {
  if (!Array.isArray(observed)) {
    findings.push(finding(domain, '*', C.OPERATIONAL_FAILURE, 'no observed evidence collected for domain'));
    return;
  }

  const observedById = new Map();
  for (const item of observed) observedById.set(item.id, item);
  const expectedById = new Map();
  for (const item of expected) expectedById.set(item.id, item);

  for (const exp of expected) {
    const obs = observedById.get(exp.id);
    if (!obs) {
      const ex = exceptionFor(manifest, domain, exp.id);
      findings.push(ex
        ? finding(domain, exp.id, C.EXPECTED_EXCEPTION, ex.reason || 'documented exception', { issue: ex.issue })
        : finding(domain, exp.id, C.MISSING_LIVE_OBJECT, 'declared in manifest but absent from live staging'));
      continue;
    }

    let drifted = false;
    for (const [field, classification] of Object.entries(fields)) {
      if (!(field in exp)) continue;
      if (obs[field] === undefined) {
        findings.push(finding(domain, exp.id, C.OPERATIONAL_FAILURE, `observed record missing field "${field}"`));
        drifted = true;
        continue;
      }
      if (JSON.stringify(obs[field]) !== JSON.stringify(exp[field])) {
        findings.push(finding(domain, exp.id, classification, `${field}: expected ${JSON.stringify(exp[field])}, live ${JSON.stringify(obs[field])}`));
        drifted = true;
      }
    }
    if (!drifted) findings.push(finding(domain, exp.id, C.MATCH, 'live state matches manifest'));
  }

  for (const obs of observed) {
    if (expectedById.has(obs.id)) continue;
    const ex = exceptionFor(manifest, domain, obs.id);
    findings.push(ex
      ? finding(domain, obs.id, C.EXPECTED_EXCEPTION, ex.reason || 'documented exception', { issue: ex.issue })
      : finding(domain, obs.id, C.UNTRACKED_LIVE_OBJECT, 'present in live staging but absent from manifest'));
  }
}

/**
 * Verifies every migration the manifest expects to be live also has recoverable
 * repository source. A null/missing repo_source is only tolerated as a declared exception.
 */
function checkMigrationSources({ manifest, findings, repoRoot, fileExists }) {
  const migrations = manifest.migrations || [];
  for (const m of migrations) {
    if (!m.repo_source) {
      const ex = exceptionFor(manifest, 'migrations', m.id);
      findings.push(ex
        ? finding('migration_source', m.id, C.EXPECTED_EXCEPTION, ex.reason || 'documented provenance exception', { issue: ex.issue })
        : finding('migration_source', m.id, C.UNTRACKED_LIVE_OBJECT, 'live migration has no repository source'));
      continue;
    }
    const exists = fileExists(path.join(repoRoot, m.repo_source));
    findings.push(exists
      ? finding('migration_source', m.id, C.MATCH, `repository source present at ${m.repo_source}`)
      : finding('migration_source', m.id, C.MISSING_LIVE_OBJECT, `declared repository source missing on disk: ${m.repo_source}`));
  }
}

/**
 * Every live Edge Function must be traceable to repository source. A function
 * with no repo_source is only tolerated when an explicit quarantine exception
 * exists, so unverifiable deployments can never silently read as parity.
 */
function checkEdgeFunctionSources({ manifest, findings, repoRoot, fileExists }) {
  const functions = manifest.edge_functions || [];
  for (const fn of functions) {
    if (!fn.repo_source) {
      const ex = exceptionFor(manifest, 'edge_functions', fn.id);
      findings.push(ex
        ? finding('edge_function_source', fn.id, C.EXPECTED_EXCEPTION, ex.reason || 'documented provenance exception', { issue: ex.issue })
        : finding('edge_function_source', fn.id, C.UNTRACKED_LIVE_OBJECT, 'live Edge Function has no repository source'));
      continue;
    }
    const exists = fileExists(path.join(repoRoot, fn.repo_source, 'index.ts'));
    findings.push(exists
      ? finding('edge_function_source', fn.id, C.MATCH, `repository source present at ${fn.repo_source}`)
      : finding('edge_function_source', fn.id, C.MISSING_LIVE_OBJECT, `declared repository source missing on disk: ${fn.repo_source}`));
  }
}

function summarize(findings) {
  const byClassification = {};
  for (const key of Object.values(C)) byClassification[key] = 0;
  for (const f of findings) byClassification[f.classification] = (byClassification[f.classification] || 0) + 1;
  const blocking = findings.filter((f) => !NON_BLOCKING.has(f.classification));
  return { byClassification, blockingCount: blocking.length, blocking };
}

function compareStagingState({ manifest, observed, repoRoot = process.cwd(), fileExists = fs.existsSync } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('compareStagingState requires a manifest object');
  }

  assertNotProduction(manifest.staging_project_ref, 'manifest.staging_project_ref');

  const findings = [];

  if (!observed || typeof observed !== 'object') {
    findings.push(finding('evidence', '*', C.OPERATIONAL_FAILURE, 'no observed staging state supplied'));
    const summary = summarize(findings);
    return { ok: false, findings, summary, stagingProjectRef: manifest.staging_project_ref };
  }

  assertNotProduction(observed.project_ref, 'observed.project_ref');

  if (observed.project_ref && observed.project_ref !== manifest.staging_project_ref) {
    findings.push(finding('evidence', 'project_ref', C.CONFIGURATION_DRIFT,
      `observed project ref ${observed.project_ref} does not match manifest ${manifest.staging_project_ref}`));
  }

  if (manifest.expected_branch_sha && observed.branch_sha && observed.branch_sha !== manifest.expected_branch_sha) {
    findings.push(finding('evidence', 'branch_sha', C.CONFIGURATION_DRIFT,
      `observed branch sha ${observed.branch_sha} does not match manifest ${manifest.expected_branch_sha}`));
  }

  diffCollection({
    domain: 'migrations',
    expected: manifest.migrations || [],
    observed: observed.migrations,
    fields: { name: C.CONFIGURATION_DRIFT },
    manifest,
    findings,
  });

  diffCollection({
    domain: 'tables',
    expected: manifest.tables || [],
    observed: observed.tables,
    fields: {},
    manifest,
    findings,
  });

  diffCollection({
    domain: 'rls',
    expected: manifest.rls || [],
    observed: observed.rls,
    fields: { rls_enabled: C.CONFIGURATION_DRIFT, policy_count: C.CONFIGURATION_DRIFT },
    manifest,
    findings,
  });

  diffCollection({
    domain: 'rpc_grants',
    expected: manifest.rpc_grants || [],
    observed: observed.rpc_grants,
    fields: {
      anon_execute: C.PRIVILEGE_DRIFT,
      authenticated_execute: C.PRIVILEGE_DRIFT,
      service_role_execute: C.PRIVILEGE_DRIFT,
      security_definer: C.CONFIGURATION_DRIFT,
      search_path: C.CONFIGURATION_DRIFT,
    },
    manifest,
    findings,
  });

  diffCollection({
    domain: 'storage',
    expected: manifest.storage || [],
    observed: observed.storage,
    fields: { public: C.CONFIGURATION_DRIFT },
    manifest,
    findings,
  });

  diffCollection({
    domain: 'edge_functions',
    expected: manifest.edge_functions || [],
    observed: observed.edge_functions,
    fields: {
      verify_jwt: C.CONFIGURATION_DRIFT,
      status: C.CONFIGURATION_DRIFT,
      ezbr_sha256: C.SOURCE_HASH_MISMATCH,
    },
    manifest,
    findings,
  });

  checkMigrationSources({ manifest, findings, repoRoot, fileExists });
  checkEdgeFunctionSources({ manifest, findings, repoRoot, fileExists });

  const summary = summarize(findings);
  return {
    ok: summary.blockingCount === 0,
    stagingProjectRef: manifest.staging_project_ref,
    findings,
    summary,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') args.state = argv[i + 1];
    if (argv[i] === '--manifest') args.manifest = argv[i + 1];
    if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest || DEFAULT_MANIFEST;

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, classification: C.OPERATIONAL_FAILURE, detail: `unreadable manifest ${manifestPath}: ${error.message}` }));
    process.exit(1);
  }

  let observed = null;
  if (args.state) {
    try {
      observed = readJson(args.state);
    } catch (error) {
      console.error(JSON.stringify({ ok: false, classification: C.OPERATIONAL_FAILURE, detail: `unreadable state file ${args.state}: ${error.message}` }));
      process.exit(1);
    }
  }

  let result;
  try {
    result = compareStagingState({ manifest, observed, repoRoot: process.cwd() });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, classification: error.code || 'OPERATIONAL_FAILURE', detail: error.message }));
    process.exit(1);
  }

  const output = {
    ok: result.ok,
    stagingProjectRef: result.stagingProjectRef,
    evidenceSupplied: Boolean(observed),
    summary: result.summary.byClassification,
    blocking: result.summary.blocking,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  CLASSIFICATIONS: C,
  DOMAINS,
  PRODUCTION_REF,
  DEFAULT_STAGING_REF,
  ProductionTargetError,
  assertNotProduction,
  compareStagingState,
  summarize,
};
