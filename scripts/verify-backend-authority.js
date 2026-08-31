#!/usr/bin/env node
'use strict';

/**
 * GOV-KPLUS-001 — backend deployment authority verification.
 *
 * The audit found that "which tree is allowed to deploy the backend" rested on
 * a mutable JSON field and nothing else:
 *
 *   1. config/backend-authority.json names a canonicalBranch
 *      (rebuild/staging-v2-backend) that is not resolvable from a fresh clone —
 *      it exists only as a LOCAL branch in some checkouts, so nobody else can
 *      confirm what the authority actually is.
 *   2. deploy-edge-functions.js's guard reads `role` out of that same JSON and
 *      proceeds on its say-so. It never checks the CHECKED-OUT REF, so the file
 *      is both the claim and the entire proof of the claim.
 *   3. governedFunctionCount had drifted to 19 against 20 governed functions
 *      (commerce-watch-refresh was added and this file was not updated), and
 *      nothing compared the two.
 *
 * DELIBERATELY NARROW (repair-brief §19 tripwire). This does NOT introduce a
 * release platform, a new deployment pipeline, or a branch-strategy change. It
 * makes the EXISTING authority checkable:
 *
 *   - the declared canonical branch resolves, and says where if it does not,
 *   - the checked-out ref is compared against it rather than assumed,
 *   - the governed count agrees with the manifest library,
 *   - governed functions and source directories agree in both directions
 *     (missing AND unexpected),
 *   - deployment metadata is bound to a git SHA and the manifest digest.
 *
 * Exit code 0 = verified, 1 = a discrepancy that must be resolved before this
 * checkout may be treated as the deployment authority. Reporting a gap is not
 * the same as failing closed on deployment: deploy-edge-functions.js keeps its
 * own guard, and this tool is what makes that guard's premise auditable.
 *
 * Usage:
 *   node scripts/verify-backend-authority.js            # human-readable
 *   node scripts/verify-backend-authority.js --json     # machine-readable
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTHORITY_PATH = path.join(REPO_ROOT, 'config', 'backend-authority.json');
const FUNCTIONS_DIR = path.join(REPO_ROOT, 'supabase', 'functions');
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'edge-function-manifest.json');

function git(args) {
  try {
    // stdio 'pipe' on stderr: an unresolvable ref is an expected outcome we
    // report ourselves, not noise to leak onto the console.
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function readAuthority() {
  if (!fs.existsSync(AUTHORITY_PATH)) return { error: 'config/backend-authority.json is missing' };
  try {
    return { value: JSON.parse(fs.readFileSync(AUTHORITY_PATH, 'utf8')) };
  } catch (error) {
    return { error: `config/backend-authority.json is not valid JSON: ${error.message}` };
  }
}

function governedFunctionsFromLib() {
  const libPath = path.join(REPO_ROOT, 'scripts', 'edge-function-manifest-lib.js');
  const lib = require(libPath);
  const names = lib.GOVERNED_FUNCTIONS || lib.governedFunctions;
  if (Array.isArray(names)) return names.slice();
  // Fall back to reading the literal if the module does not export it.
  const source = fs.readFileSync(libPath, 'utf8');
  const match = /GOVERNED_FUNCTIONS\s*=\s*\[([\s\S]*?)\]/.exec(source);
  return match ? [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]) : [];
}

function sourceFunctionDirs() {
  if (!fs.existsSync(FUNCTIONS_DIR)) return [];
  return fs
    .readdirSync(FUNCTIONS_DIR)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => fs.statSync(path.join(FUNCTIONS_DIR, name)).isDirectory())
    .sort();
}

function verify() {
  const findings = [];
  const info = {};
  const fail = (code, message) => findings.push({ severity: 'error', code, message });
  const warn = (code, message) => findings.push({ severity: 'warning', code, message });

  const authorityRead = readAuthority();
  if (authorityRead.error) {
    fail('AUTHORITY_UNREADABLE', authorityRead.error);
    return { ok: false, findings, info };
  }
  const authority = authorityRead.value;
  info.role = authority.role ?? null;
  info.canonicalBranch = authority.canonicalBranch ?? null;
  info.approvedProjectRef = authority.approvedProjectRef ?? null;

  // ── 1. the canonical branch must be resolvable ────────────────────────────
  if (!authority.canonicalBranch) {
    fail('CANONICAL_BRANCH_MISSING', 'config/backend-authority.json declares no canonicalBranch.');
  } else {
    const remote = git(['rev-parse', '--verify', `origin/${authority.canonicalBranch}`]);
    const local = git(['rev-parse', '--verify', `refs/heads/${authority.canonicalBranch}`]);
    info.canonicalBranchRemoteSha = remote;
    info.canonicalBranchLocalSha = local;
    if (!remote && !local) {
      fail(
        'CANONICAL_BRANCH_UNRESOLVABLE',
        `canonicalBranch "${authority.canonicalBranch}" resolves neither on origin nor locally. ` +
          'The declared deployment authority cannot be verified by anyone.',
      );
    } else if (!remote) {
      warn(
        'CANONICAL_BRANCH_LOCAL_ONLY',
        `canonicalBranch "${authority.canonicalBranch}" exists only as a LOCAL ref. ` +
          'A fresh clone cannot resolve the declared deployment authority. Publish it, or ' +
          're-point canonicalBranch at a published ref (owner action).',
      );
    }
  }

  // ── 2. bind this checkout to a real ref, not just to JSON ─────────────────
  const headSha = git(['rev-parse', 'HEAD']);
  info.headSha = headSha;
  info.headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  info.workingTreeClean = git(['status', '--porcelain']) === '';

  const isDeclaredAuthority = authority.role === 'backend-deployment-authority';
  info.declaresDeploymentAuthority = isDeclaredAuthority;

  if (isDeclaredAuthority) {
    // A tree that CLAIMS to be the authority must actually be on (or descend
    // from) the declared branch. Previously the claim was self-certifying.
    const target =
      info.canonicalBranchRemoteSha
      ?? info.canonicalBranchLocalSha
      ?? null;
    if (!target) {
      fail(
        'AUTHORITY_REF_UNVERIFIABLE',
        'This checkout claims to be the backend deployment authority, but the declared ' +
          'canonical branch does not resolve, so the claim cannot be checked.',
      );
    } else {
      const descends = git(['merge-base', '--is-ancestor', target, headSha]) !== null;
      info.headDescendsFromCanonical = descends;
      if (!descends) {
        fail(
          'AUTHORITY_REF_MISMATCH',
          `This checkout claims to be the backend deployment authority, but HEAD (${headSha}) ` +
            `does not contain the canonical branch tip (${target}).`,
        );
      }
    }
    if (!info.workingTreeClean) {
      fail(
        'AUTHORITY_TREE_DIRTY',
        'The deployment authority must not deploy from a dirty working tree: what would be ' +
          'deployed is not attributable to any commit.',
      );
    }
  }

  // ── 3. governed count must agree with the manifest library ────────────────
  const governed = governedFunctionsFromLib();
  const sources = sourceFunctionDirs();
  info.governedCount = governed.length;
  info.sourceCount = sources.length;

  if (typeof authority.governedFunctionCount === 'number'
      && authority.governedFunctionCount !== governed.length) {
    fail(
      'GOVERNED_COUNT_MISMATCH',
      `config/backend-authority.json claims ${authority.governedFunctionCount} governed ` +
        `functions; scripts/edge-function-manifest-lib.js governs ${governed.length}.`,
    );
  }

  // ── 4. missing AND unexpected, in both directions ─────────────────────────
  const governedSet = new Set(governed);
  const sourceSet = new Set(sources);
  const missingFromSource = governed.filter((n) => !sourceSet.has(n));
  const ungoverned = sources.filter((n) => !governedSet.has(n));
  info.missingFromSource = missingFromSource;
  info.ungovernedSourceDirs = ungoverned;

  if (missingFromSource.length) {
    fail(
      'GOVERNED_FUNCTION_MISSING',
      `Governed but absent from source: ${missingFromSource.join(', ')}.`,
    );
  }
  if (ungoverned.length) {
    fail(
      'UNGOVERNED_FUNCTION_PRESENT',
      `Present in source but not governed: ${ungoverned.join(', ')}. An ungoverned function ` +
        'has no manifest digest, so a deploy of it is unattributable.',
    );
  }

  // ── 5. bind deployment metadata to SHA + manifest digest ──────────────────
  if (fs.existsSync(MANIFEST_PATH)) {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    info.manifestDigest = require('crypto').createHash('sha256').update(raw).digest('hex');
    try {
      const manifest = JSON.parse(raw);
      info.manifestProvenance = manifest.provenance ?? null;
    } catch (error) {
      fail('MANIFEST_UNREADABLE', `config/edge-function-manifest.json is not valid JSON: ${error.message}`);
    }
  } else {
    fail('MANIFEST_MISSING', 'config/edge-function-manifest.json is missing.');
  }

  const errors = findings.filter((f) => f.severity === 'error');
  return { ok: errors.length === 0, findings, info };
}

function main() {
  const asJson = process.argv.includes('--json');
  const result = verify();

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('── Backend deployment authority ────────────────────────────────');
    console.log(`  role                : ${result.info.role}`);
    console.log(`  canonicalBranch     : ${result.info.canonicalBranch}`);
    console.log(`  canonical (origin)  : ${result.info.canonicalBranchRemoteSha ?? '(unresolved)'}`);
    console.log(`  canonical (local)   : ${result.info.canonicalBranchLocalSha ?? '(unresolved)'}`);
    console.log(`  HEAD                : ${result.info.headSha} (${result.info.headBranch})`);
    console.log(`  working tree clean  : ${result.info.workingTreeClean}`);
    console.log(`  governed / source   : ${result.info.governedCount} / ${result.info.sourceCount}`);
    console.log(`  manifest digest     : ${result.info.manifestDigest ?? '(none)'}`);
    console.log('');
    if (!result.findings.length) {
      console.log('PASS  No authority discrepancies.');
    } else {
      for (const finding of result.findings) {
        console.log(`${finding.severity === 'error' ? 'FAIL' : 'WARN'}  [${finding.code}] ${finding.message}`);
      }
    }
  }
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { verify, governedFunctionsFromLib, sourceFunctionDirs };
