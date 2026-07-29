'use strict';

/**
 * Certified v140 source verification (Phase 0C Lane C).
 *
 * WHY THIS EXISTS: Phase 0B treated the research branch's local Scanner source
 * as the equivalence basis. That was wrong. The research branch descends from
 * the certification commit but has drifted FORWARD by two commits that added
 * the `identify_for_closet` intent AFTER v140 was certified. Its bundle hashes
 * to 9d645f5e…; the certified v140 bundle hashes to 28737e0c….
 *
 * The evaluation adapter must therefore be built from the CERTIFIED tree, never
 * from HEAD.
 *
 * Every hash is re-derived from the git object store. Nothing here trusts the
 * committed manifest — the manifest is only cross-checked against the
 * re-derivation, so a tampered manifest is detected rather than believed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RECORD_PATH = path.join(__dirname, '..', 'adapter', 'certified-v140.json');

function loadRecord() {
  return JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8'));
}

/** Read a blob from any ref without checking anything out. */
function readBlob(ref, filePath) {
  return execFileSync('git', ['show', `${ref}:${filePath}`], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Order-independent aggregate over `path:hash` pairs; mirrors the manifest lib. */
function aggregateHash(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}:${entry.sha256}\n`);
  }
  return hash.digest('hex');
}

/**
 * Verify that a ref carries the certified v140 closure, byte for byte.
 *
 * @param {string} ref defaults to the certified iOS cert commit
 * @returns {{ ok: boolean, bundleHash: string, expectedBundleHash: string,
 *             fileCount: number, mismatches: Array, missing: Array }}
 */
function verifyClosure(ref) {
  const record = loadRecord();
  const target = ref || record.certifiedBranches.ios.sha;

  if (!refExists(target)) {
    return {
      ok: false,
      ref: target,
      error: `ref not found: ${target}`,
      mismatches: [],
      missing: [],
    };
  }

  const mismatches = [];
  const missing = [];
  const derived = [];

  for (const file of record.files) {
    let bytes;
    try {
      bytes = readBlob(target, file.path);
    } catch {
      missing.push(file.path);
      continue;
    }
    const actual = sha256(bytes);
    derived.push({ path: file.path, sha256: actual, bundle: file.bundle });
    if (actual !== file.sha256) {
      mismatches.push({ path: file.path, expected: file.sha256, actual, bundle: file.bundle });
    }
  }

  const bundleHash = aggregateHash(derived.filter((d) => d.bundle));
  const treeHash = aggregateHash(derived);

  return {
    ok: mismatches.length === 0 && missing.length === 0 && bundleHash === record.bundleHash,
    ref: target,
    bundleHash,
    expectedBundleHash: record.bundleHash,
    treeHash,
    expectedTreeHash: record.treeHash,
    fileCount: derived.length,
    expectedFileCount: record.treeFileCount,
    bundleFileCount: derived.filter((d) => d.bundle).length,
    expectedBundleFileCount: record.bundleFileCount,
    mismatches,
    missing,
  };
}

/**
 * Report how a candidate ref differs from the certified closure.
 * Used to prove the research branch is NOT the certified source.
 */
function compareToCertified(candidateRef) {
  const result = verifyClosure(candidateRef);
  const record = loadRecord();
  return {
    candidateRef,
    isCertifiedSource: result.ok,
    candidateBundleHash: result.bundleHash,
    certifiedBundleHash: record.bundleHash,
    driftedFiles: result.mismatches.map((m) => m.path),
    missingFiles: result.missing,
    bundleDrift: result.mismatches.filter((m) => m.bundle).map((m) => m.path),
    verdict: result.ok
      ? 'IDENTICAL to certified v140 closure'
      : 'NOT the certified v140 closure — an adapter built from this ref would not measure deployed behaviour',
  };
}

/**
 * Boundary properties asserted directly against the CERTIFIED source text, so a
 * future change to the certified pin cannot silently invalidate the adapter's
 * safety argument.
 */
function verifyCertifiedBoundaries(ref) {
  const record = loadRecord();
  const target = ref || record.certifiedBranches.ios.sha;
  const contract = readBlob(target, 'supabase/functions/_shared/fashionIdentificationV2.ts').toString('utf8');

  const intents = (contract.match(/FASHION_IDENTIFICATION_INTENTS = \[([\s\S]*?)\]/) || [])[1] || '';
  const intentList = [...intents.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  const checks = [
    {
      check: 'commerce_gated_by_intent',
      ok: /shouldRunCommerce/.test(contract) && /identify_for_style'\s*\)\s*\{\s*return \{ run: false/.test(contract.replace(/\s+/g, ' ')),
      detail:
        'shouldRunCommerce is the single commerce decision point and returns run:false for identify_for_style. Commerce is disabled through a production dependency boundary, not a modification.',
    },
    {
      check: 'exact_product_null',
      ok: (contract.match(/exactProduct: null/g) || []).length >= 3,
      detail: 'MC-1 holds at the certified source: exactProduct is hardcoded null.',
    },
    {
      check: 'intents_are_v140',
      ok: intentList.length === 2 && intentList.includes('identify_and_shop') && intentList.includes('identify_for_style'),
      detail: `certified intents: ${intentList.join(', ')}. identify_for_closet was added AFTER certification and is NOT in deployed v140.`,
      observed: intentList,
    },
    {
      check: 'identify_for_closet_absent',
      ok: !intentList.includes('identify_for_closet'),
      detail: 'The adapter must not send identify_for_closet — deployed v140 would reject it as invalid_intent.',
    },
  ];

  return { ref: target, ok: checks.every((c) => c.ok), checks };
}

module.exports = {
  RECORD_PATH,
  loadRecord,
  readBlob,
  refExists,
  sha256,
  aggregateHash,
  verifyClosure,
  compareToCertified,
  verifyCertifiedBoundaries,
};
