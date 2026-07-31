#!/usr/bin/env node
'use strict';

/**
 * Dataset freeze gate (Phase 0B section 11).
 *
 * A freeze is the point after which a dataset version is immutable and a paid
 * run may quote it. Every precondition below must hold. The gate FAILS CLOSED:
 * it refuses to emit a frozen manifest when anything is unresolved, rather than
 * emitting one with warnings that a later reader would skim past.
 *
 * Usage
 *   node tools/scanner-evaluation/freeze-dataset.js <manifest.json> [--write]
 *
 * Without --write it reports only. With --write it emits the frozen manifest
 * and the freeze record, but only if every precondition passed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { validateManifest, validateCase } = require('./lib/datasetValidate');
const { validateSplit } = require('./lib/datasetSplit');
const ontology = require('./lib/ontology');
const resultState = require('./lib/resultState');
const { SCORING_CONTRACT_VERSION } = require('./lib/scoreFields');

const ROOT = path.resolve(__dirname, '..', '..');

/** Section 6 first-baseline targets. */
const TARGET_CASE_COUNT = 75;
const TARGET_DEVELOPMENT = 60;
const TARGET_HOLDOUT = 15;

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gate(name, ok, detail) {
  return { gate: name, ok: Boolean(ok), detail };
}

function evaluateFreeze(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const gates = [];

  // 1. Every case validates under the full Phase 0B contract.
  const structural = validateManifest(manifest, { expectedDatasetVersion: manifest.datasetVersion });
  const perCaseErrors = [];
  for (const caseRecord of cases) {
    const result = validateCase(caseRecord, {
      expectedDatasetVersion: manifest.datasetVersion,
      requirePhase0bPrivacy: true,
      requireTwoReviewers: true,
    });
    if (!result.ok) {
      perCaseErrors.push({ caseId: caseRecord.caseId, errors: result.errors });
    }
  }
  gates.push(gate('structural_validation', structural.ok, structural.errors));
  gates.push(
    gate('phase0b_case_validation', perCaseErrors.length === 0, {
      failingCases: perCaseErrors.length,
      sample: perCaseErrors.slice(0, 3),
    })
  );

  // 2. Case count reaches the first-baseline target.
  gates.push(
    gate('case_count', cases.length >= TARGET_CASE_COUNT, {
      required: TARGET_CASE_COUNT,
      found: cases.length,
      shortfall: Math.max(0, TARGET_CASE_COUNT - cases.length),
    })
  );

  // 3. Every referenced image exists and hashes as recorded.
  const hashFailures = [];
  for (const caseRecord of cases) {
    const refs = Array.isArray(caseRecord.imageReferences) ? caseRecord.imageReferences : [];
    const hashes = Array.isArray(caseRecord.imageHashes) ? caseRecord.imageHashes : [];
    refs.forEach((ref, index) => {
      const absolute = path.join(ROOT, ref.refValue);
      if (!fs.existsSync(absolute)) {
        hashFailures.push({ caseId: caseRecord.caseId, ref: ref.refValue, reason: 'missing' });
        return;
      }
      const actual = `sha256:${sha256Hex(fs.readFileSync(absolute))}`;
      if (actual !== hashes[index]) {
        hashFailures.push({ caseId: caseRecord.caseId, ref: ref.refValue, reason: 'hash_mismatch' });
      }
    });
  }
  gates.push(gate('image_hashes', hashFailures.length === 0, hashFailures.slice(0, 5)));

  // 4. Authorization is verified, not merely asserted.
  const unverified = cases.filter(
    (c) => c.authorizationStatus === 'unverified_claim' || !c.authorizationReference
  );
  gates.push(
    gate('authorization_verified', unverified.length === 0, {
      unverifiedCases: unverified.map((c) => c.caseId).slice(0, 10),
    })
  );

  // 5. Two-reviewer labeling is complete and adjudications are closed.
  const unreviewed = cases.filter((c) => (c.reviewerCount || 0) < 2 || c.reviewStatus !== 'approved');
  const openAdjudications = cases.filter(
    (c) => c.adjudication && c.adjudication.required === true && !c.adjudication.resolved
  );
  gates.push(gate('two_reviewer_labeling', unreviewed.length === 0, { pending: unreviewed.length }));
  gates.push(gate('adjudications_closed', openAdjudications.length === 0, { open: openAdjudications.length }));

  // 6. Development / holdout split is present, valid and correctly sized.
  const split = manifest.split;
  if (!split || !Array.isArray(split.development) || !Array.isArray(split.holdout)) {
    gates.push(gate('split_present', false, 'manifest carries no development/holdout split'));
  } else {
    const report = validateSplit(cases, split);
    gates.push(gate('split_valid', report.ok, report.errors));
    gates.push(
      gate('split_sizes', split.development.length === TARGET_DEVELOPMENT && split.holdout.length === TARGET_HOLDOUT, {
        required: { development: TARGET_DEVELOPMENT, holdout: TARGET_HOLDOUT },
        found: { development: split.development.length, holdout: split.holdout.length },
      })
    );
    gates.push(gate('holdout_strata', report.missingStrata.length === 0, report.missingStrata));
  }

  // 7. No case is blocked on privacy.
  const blocked = cases.filter((c) => c.privacyDisposition === 'blocked_private');
  gates.push(gate('no_blocked_privacy', blocked.length === 0, blocked.map((c) => c.caseId)));

  const ok = gates.every((g) => g.ok);

  return {
    ok,
    manifestPath: path.relative(ROOT, manifestPath),
    datasetVersion: manifest.datasetVersion,
    caseCount: cases.length,
    manifestSha256: sha256Hex(Buffer.from(raw, 'utf8')),
    gates,
    failedGates: gates.filter((g) => !g.ok).map((g) => g.gate),
  };
}

function buildFreezeRecord(evaluation, manifest) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return {
    frozen: true,
    datasetVersion: evaluation.datasetVersion,
    manifestSha256: evaluation.manifestSha256,
    caseCount: evaluation.caseCount,
    sourceSha,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    ontologyVersions: ontology.ONTOLOGY_VERSIONS,
    resultStateMappingVersion: resultState.MAPPING_VERSION,
    imageHashes: manifest.cases.flatMap((c) => c.imageHashes || []),
    split: manifest.split,
    immutabilityRule:
      'After this record exists the dataset version is immutable. A labeling correction requires a NEW patch version; the active version is never edited. Reports never combine results across dataset versions.',
  };
}

function main(argv = process.argv.slice(2)) {
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: node freeze-dataset.js <manifest.json> [--write]');
    process.exitCode = 1;
    return { ok: false };
  }
  const manifestPath = path.isAbsolute(target) ? target : path.join(ROOT, target);
  const evaluation = evaluateFreeze(manifestPath);

  if (!evaluation.ok) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          verdict: 'FREEZE REFUSED',
          datasetVersion: evaluation.datasetVersion,
          caseCount: evaluation.caseCount,
          failedGates: evaluation.failedGates,
          gates: evaluation.gates.filter((g) => !g.ok),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return evaluation;
  }

  if (argv.includes('--write')) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const record = buildFreezeRecord(evaluation, manifest);
    const out = path.join(ROOT, 'evals/scanner-accuracy/freeze', `freeze-${evaluation.datasetVersion}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, verdict: 'FROZEN', freezeRecord: path.relative(ROOT, out) }, null, 2));
    return { ...evaluation, freezeRecord: out };
  }

  console.log(JSON.stringify({ ok: true, verdict: 'FREEZE PRECONDITIONS MET', datasetVersion: evaluation.datasetVersion }, null, 2));
  return evaluation;
}

if (require.main === module) main();

module.exports = { main, evaluateFreeze, TARGET_CASE_COUNT, TARGET_DEVELOPMENT, TARGET_HOLDOUT };
