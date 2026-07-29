#!/usr/bin/env node
'use strict';

/**
 * Static offline baseline scaffolding.
 * Does NOT call paid models. Emits an experiment shell from local metadata only.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { validateManifest } = require('./lib/datasetValidate');
const { scoreCase, aggregateScores } = require('./lib/scoreFields');
const { validateExperimentRecord } = require('./lib/experimentMeta');

function git(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const datasetVersionPath = path.join(root, 'evals/scanner-accuracy/dataset-version.json');
  const manifestPath = path.join(
    root,
    'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json'
  );
  const datasetVersion = JSON.parse(fs.readFileSync(datasetVersionPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validated = validateManifest(manifest, {
    expectedDatasetVersion: datasetVersion.datasetVersion,
  });
  if (!validated.ok) {
    console.error(JSON.stringify({ ok: false, errors: validated.errors }, null, 2));
    process.exit(1);
  }

  // Static baseline uses empty predictions → field scores reflect honest unknown vs labeled fields.
  const caseScores = validated.cases.map((label) => scoreCase(label, {}));
  const metrics = aggregateScores(caseScores);

  const sourceSha = git('git rev-parse HEAD');
  const scanIdentifyTreeHash = git('git rev-parse HEAD:supabase/functions/scan-identify');
  const sharedContractTreeHash = git(
    'git rev-parse HEAD:supabase/functions/_shared/fashionIdentificationV2.ts'
  );

  const now = new Date().toISOString();
  const record = {
    experimentId: `static-baseline-shell-${datasetVersion.datasetVersion}`,
    sourceSha,
    scanIdentifyTreeHash,
    sharedContractTreeHash,
    datasetVersion: datasetVersion.datasetVersion,
    pipelineVersion: 'static-harness-0.1.0',
    promptVersion: 'production-unmodified-not-executed',
    modelConfiguration: {
      provider: 'none',
      note: 'Paid model evaluation not authorized in Phase 0A static harness',
      productionAllowlistDocumented: {
        scannerPrimary: 'gemini-3.6-flash',
        scannerFallback: 'gemini-3.5-flash-lite',
      },
    },
    schemaVersion: 'fashion-identification-v2',
    preprocessingVersion: 'none',
    thresholdVersion: 'documented-production-not-executed',
    retrievalVersion: 'documented-production-not-executed',
    rerankingVersion: 'documented-production-not-executed',
    startedAt: now,
    completedAt: now,
    caseCount: validated.cases.length,
    metrics,
    latency: { totalMs: 0, perCaseMs: [] },
    modelCallCount: 0,
    costEstimate: { currency: 'USD', amount: 0, note: 'no paid calls' },
    notes:
      'Static shell only. Empty predictions. Not a measured production baseline. Paid baseline requires explicit authorization.',
    scoringContractVersion: datasetVersion.scoringContractVersion,
    deployedScanIdentifyVersionObserved: 140,
  };

  const meta = validateExperimentRecord(record);
  if (!meta.ok) {
    console.error(JSON.stringify({ ok: false, errors: meta.errors }, null, 2));
    process.exit(1);
  }

  const outDir = path.join(root, 'evals/scanner-accuracy/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `static-baseline-shell-${datasetVersion.datasetVersion}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, outPath, caseCount: record.caseCount, modelCallCount: 0 }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { main };
