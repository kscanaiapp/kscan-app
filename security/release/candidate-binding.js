#!/usr/bin/env node
'use strict';

/**
 * Manifest-aware candidate binding for staging deployment.
 *
 * This is the control that makes exact-candidate verification truthful. The
 * existing staging deployment path (security-staging-gate.yml /
 * staging-controlled-deploy.yml) is change-scoped and manifest-unaware: it
 * deploys whatever the PR touched, from the runner's working tree. That is
 * efficient and worth keeping, but on its own it cannot answer "is the thing
 * you deployed the thing you froze?".
 *
 * This module answers that, without replacing the deployer:
 *
 *   1. the candidate is an IMMUTABLE git object, never the working tree
 *   2. the frozen manifest is regenerated FROM that object and must match
 *   3. the deployment delta must be a SUBSET of the governed inventory
 *   4. the environment must resolve to staging
 *
 * DIRTY-WORKTREE RULE: every file that will be deployed is read via
 * `git show <sha>:<path>`, so a modified, staged, or untracked file on the
 * runner cannot enter a release. A dirty tree does not merely warn — if the
 * tree differs from the candidate in any release-relevant path, binding is
 * refused, because at that point nobody can say which bytes would ship.
 *
 * Node built-ins only. Read-only: nothing here deploys, mutates Supabase, or
 * writes to the repository.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority.js');

const BINDING_SCHEMA_VERSION = 1;

/** Paths whose contents are release-relevant, i.e. must come from the candidate. */
const RELEASE_RELEVANT_PREFIXES = Object.freeze([
  'supabase/functions/',
  'supabase/migrations/',
  'supabase/config.toml',
  'config/edge-function-manifest.json',
]);

class CandidateBindingError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'CandidateBindingError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isReleaseRelevant(repoPath) {
  return RELEASE_RELEVANT_PREFIXES.some((prefix) => (
    prefix.endsWith('/') ? repoPath.startsWith(prefix) : repoPath === prefix
  ));
}

/** Resolves a candidate ref to a full SHA, proving the commit actually exists. */
function resolveCandidate(repoRoot, candidateRef) {
  if (!candidateRef) {
    throw new CandidateBindingError('candidate ref is required', 'MISSING_CANDIDATE');
  }
  let sha;
  try {
    sha = git(repoRoot, ['rev-parse', '--verify', `${candidateRef}^{commit}`]).trim();
  } catch {
    throw new CandidateBindingError(`candidate does not resolve to a commit: ${candidateRef}`, 'CANDIDATE_NOT_FOUND');
  }
  let treeSha;
  try {
    treeSha = git(repoRoot, ['rev-parse', `${sha}^{tree}`]).trim();
  } catch {
    throw new CandidateBindingError(`candidate has no resolvable tree: ${sha}`, 'CANDIDATE_TREE_NOT_FOUND');
  }
  return { sha, treeSha };
}

/**
 * Reads a file's contents from the immutable candidate object, never the
 * working tree. Returns null when the path does not exist in the candidate.
 */
function readFromCandidate(repoRoot, candidateSha, repoPath) {
  try {
    return git(repoRoot, ['show', `${candidateSha}:${repoPath}`]);
  } catch {
    return null;
  }
}

/**
 * Detects release-relevant divergence between the working tree and the
 * candidate. Any difference in a release-relevant path is disqualifying.
 */
function findWorkingTreeDivergence(repoRoot, candidateSha) {
  let output;
  try {
    output = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  } catch {
    throw new CandidateBindingError('cannot read working tree status', 'WORKTREE_STATUS_UNAVAILABLE');
  }

  const dirty = output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    // Rename entries read "old -> new"; the destination is what would ship.
    .map((entry) => (entry.includes(' -> ') ? entry.split(' -> ')[1] : entry))
    .map((entry) => entry.replace(/^"|"$/g, ''))
    .filter(isReleaseRelevant);

  // A path can also diverge without being dirty if HEAD is not the candidate.
  let committedDiff = [];
  try {
    committedDiff = git(repoRoot, ['diff', '--name-only', candidateSha, 'HEAD'])
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .filter(isReleaseRelevant);
  } catch {
    // A detached/unborn HEAD is not itself disqualifying; the dirty check above
    // plus candidate-sourced reads still constrain what can ship.
  }

  return [...new Set([...dirty, ...committedDiff])].sort();
}

/**
 * Validates that a proposed deployment delta is a subset of the governed
 * release inventory, and that nothing quarantined or unclassified sneaks in.
 *
 * @param {object} opts
 * @param {object} opts.manifest         - release manifest for the candidate
 * @param {string[]} opts.functions      - function slugs the deployer intends to deploy
 * @param {string[]} opts.migrations     - migration names the deployer intends to apply
 */
function validateDeploymentDelta({ manifest, functions = [], migrations = [] }) {
  const violations = [];

  const byName = new Map((manifest.edgeFunctions || []).map((fn) => [fn.name, fn]));
  const governed = new Set(
    (manifest.edgeFunctions || []).filter((fn) => fn.releaseIncluded).map((fn) => fn.name),
  );
  const manifestMigrations = new Set((manifest.migrations || []).map((m) => m.name));

  for (const slug of functions) {
    const entry = byName.get(slug);
    if (!entry) {
      violations.push({ code: 'UNKNOWN_COMPONENT', component: slug, detail: 'not present in the release manifest inventory' });
      continue;
    }
    if (entry.class === 'QUARANTINED') {
      violations.push({ code: 'QUARANTINED_COMPONENT', component: slug, detail: 'quarantined components must never be deployed by release automation' });
      continue;
    }
    if (entry.class === 'HERITAGE_UNMANAGED') {
      violations.push({ code: 'HERITAGE_COMPONENT', component: slug, detail: 'heritage-unmanaged components have no repository source to deploy from' });
      continue;
    }
    if (!governed.has(slug)) {
      violations.push({ code: 'NOT_GOVERNED', component: slug, detail: `class ${entry.class} is not release-included` });
      continue;
    }
    if (!entry.sourceHash) {
      violations.push({ code: 'MISSING_SOURCE_HASH', component: slug, detail: 'governed component has no recorded source hash' });
    }
  }

  for (const name of migrations) {
    if (!manifestMigrations.has(name)) {
      violations.push({ code: 'MIGRATION_NOT_IN_MANIFEST', component: name, detail: 'migration is not part of the frozen candidate' });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Binds a deployment to a frozen candidate.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.candidateRef            - commit-ish for the candidate
 * @param {object} opts.frozen                  - freeze record from freezeManifest()
 * @param {object} opts.manifest                - manifest regenerated from the candidate
 * @param {'staging'} opts.expectedEnvironment
 * @param {string} opts.projectRef
 * @param {string[]} [opts.functions]
 * @param {string[]} [opts.migrations]
 * @param {string} [opts.currentStagingHead]    - live staging HEAD, for staleness
 * @param {boolean} [opts.requireCurrentStagingHead=false]
 * @param {function} [opts.verifyFreeze]        - injected for testability
 * @returns {{ok: boolean, binding: object, violations: object[]}}
 */
function bindCandidate(opts) {
  const {
    repoRoot,
    candidateRef,
    frozen,
    manifest,
    expectedEnvironment = 'staging',
    projectRef,
    functions = [],
    migrations = [],
    currentStagingHead = null,
    requireCurrentStagingHead = false,
    verifyFreeze,
  } = opts || {};

  const violations = [];

  // Environment first: fail closed before doing any work.
  assertExpectedEnvironment(expectedEnvironment, projectRef);

  const { sha, treeSha } = resolveCandidate(repoRoot, candidateRef);

  if (!frozen) throw new CandidateBindingError('a freeze record is required', 'MISSING_FREEZE');
  if (!manifest) throw new CandidateBindingError('a candidate manifest is required', 'MISSING_MANIFEST');

  if (frozen.sourceSha !== sha) {
    violations.push({
      code: 'CANDIDATE_SHA_MISMATCH',
      detail: `freeze binds ${frozen.sourceSha} but the candidate resolves to ${sha}`,
    });
  }

  if (typeof verifyFreeze === 'function') {
    const freezeResult = verifyFreeze(frozen, manifest);
    if (!freezeResult.valid) {
      for (const reason of freezeResult.reasons) {
        violations.push({ code: 'FREEZE_INVALID', detail: reason });
      }
    }
  }

  // Dirty / diverged working tree: refuse rather than warn.
  const diverged = findWorkingTreeDivergence(repoRoot, sha);
  if (diverged.length > 0) {
    violations.push({
      code: 'WORKING_TREE_DIVERGED',
      detail: `release-relevant paths differ from the candidate: ${diverged.slice(0, 10).join(', ')}${diverged.length > 10 ? ` (+${diverged.length - 10} more)` : ''}`,
    });
  }

  // Staleness: only enforced when the policy demands the candidate be current.
  if (requireCurrentStagingHead) {
    if (!currentStagingHead) {
      violations.push({ code: 'STAGING_HEAD_UNKNOWN', detail: 'policy requires a current candidate but staging HEAD was not supplied' });
    } else if (currentStagingHead !== sha) {
      violations.push({
        code: 'STALE_CANDIDATE',
        detail: `candidate ${sha} is not current staging HEAD ${currentStagingHead}`,
      });
    }
  }

  const delta = validateDeploymentDelta({ manifest, functions, migrations });
  violations.push(...delta.violations);

  // Every deployable file is read from the immutable candidate, and its hash
  // recorded, so the receipt can prove what was actually shipped.
  const deployableSources = {};
  for (const slug of functions) {
    const entry = (manifest.edgeFunctions || []).find((fn) => fn.name === slug);
    if (!entry || !entry.sourcePath) continue;
    let listing = [];
    try {
      listing = git(repoRoot, ['ls-tree', '-r', '--name-only', sha, '--', entry.sourcePath])
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .sort();
    } catch {
      violations.push({ code: 'CANDIDATE_SOURCE_UNREADABLE', component: slug, detail: `cannot list ${entry.sourcePath} in ${sha}` });
      continue;
    }
    if (listing.length === 0) {
      violations.push({ code: 'CANDIDATE_SOURCE_MISSING', component: slug, detail: `${entry.sourcePath} is absent from the candidate` });
      continue;
    }
    const parts = [];
    for (const filePath of listing) {
      const contents = readFromCandidate(repoRoot, sha, filePath);
      if (contents === null) {
        violations.push({ code: 'CANDIDATE_SOURCE_UNREADABLE', component: slug, detail: filePath });
        continue;
      }
      parts.push(`${filePath}:${sha256(contents)}`);
    }
    deployableSources[slug] = sha256(parts.join('\n'));
  }

  const binding = {
    schemaVersion: BINDING_SCHEMA_VERSION,
    releaseId: frozen.releaseId,
    candidateSha: sha,
    candidateTreeSha: treeSha,
    manifestDigest: manifest.identityDigest,
    frozenManifestDigest: frozen.identityDigest,
    environment: expectedEnvironment,
    projectRef,
    deploymentDelta: {
      functions: [...functions].sort(),
      migrations: [...migrations].sort(),
    },
    candidateSourceHashes: deployableSources,
    healthContractVersion: manifest.healthContractVersion,
    configFingerprint: manifest.configFingerprint,
    sourceExtractionMethod: 'git-show-from-immutable-candidate',
  };

  return { ok: violations.length === 0, binding, violations };
}

module.exports = {
  BINDING_SCHEMA_VERSION,
  RELEASE_RELEVANT_PREFIXES,
  CandidateBindingError,
  resolveCandidate,
  readFromCandidate,
  isReleaseRelevant,
  findWorkingTreeDivergence,
  validateDeploymentDelta,
  bindCandidate,
};
