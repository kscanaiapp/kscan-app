#!/usr/bin/env node
'use strict';

/**
 * CLI entry point — spec section 57 (MODES).
 *
 * Usage:
 *   node tools/elise-concierge-eval/runner.js <MODE> [options]
 *
 * Modes: CONTRACT | CORPUS | SYNTHESIZE | EVALUATE | REPORT | VALIDATE |
 *        L1_5_CONTEXT | OWNER_REPLAY
 *
 * There is NO live-model mode, ever. Every mode here is offline and
 * zero-spend: fixture generation, deterministic synthesis, and evaluation
 * against synthetic text, plus (L1_5_CONTEXT) a local, non-network execution
 * of real production pure functions.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPORTS_DIR = path.join(__dirname, 'reports');

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function modeContract() {
  const { DEFECT_TAXONOMY_VERSION, DEFECTS } = require('./model/defectTaxonomy');
  const { PRECEDENCE_CONTRACT_VERSION } = require('./model/precedenceContract');
  const { EXTRACTION_RULES_VERSION } = require('./model/claimSchema');
  const { SYNTHESIZER_VERSION } = require('./synthesis/responseSynthesizer');
  const { TASK_TAXONOMY_VERSION, TASKS } = require('./model/taskTaxonomy');
  const { RUBRIC_VERSION } = require('./human-review/rubric');
  const { FIXTURE_SCHEMA_VERSION } = require('./schema/fixtureSchema');
  printJson({
    defectTaxonomyVersion: DEFECT_TAXONOMY_VERSION,
    defectCodes: DEFECTS.map((d) => d.code),
    precedenceContractVersion: PRECEDENCE_CONTRACT_VERSION,
    extractionRulesVersion: EXTRACTION_RULES_VERSION,
    synthesizerVersion: SYNTHESIZER_VERSION,
    taskTaxonomyVersion: TASK_TAXONOMY_VERSION,
    taskCount: TASKS.length,
    rubricVersion: RUBRIC_VERSION,
    fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
  });
}

function modeCorpus(args) {
  const { buildCorpus } = require('./metrics/corpusRunner');
  const { hashCorpus } = require('./reports/generateReport');
  const { cases, skipped } = buildCorpus();
  const summary = { caseCount: cases.length, skippedCount: skipped.length, corpusHash: hashCorpus(cases) };
  printJson(summary);
  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && args[outIdx + 1]) {
    fs.writeFileSync(path.resolve(args[outIdx + 1]), JSON.stringify({ cases, skipped }, null, 2));
    console.error(`Wrote full corpus to ${args[outIdx + 1]}`);
  }
}

function modeSynthesize(args) {
  const { getFixtures } = require('./fixtures');
  const { synthesizeResponse } = require('./synthesis/responseSynthesizer');
  const scenarioId = args[0];
  const systemProfile = args[1];
  const script = args[2];
  if (!scenarioId || !systemProfile || !script) {
    console.error('Usage: runner.js SYNTHESIZE <scenarioId> <ELISE|CONCIERGE> <CLEAN|AMBIGUITY|D01..D16>');
    process.exit(2);
  }
  const fixtures = getFixtures();
  printJson(synthesizeResponse({ scenarioId, systemProfile, script, fixtures }));
}

function modeEvaluate(args) {
  const { getFixtures } = require('./fixtures');
  const { synthesizeResponse } = require('./synthesis/responseSynthesizer');
  const { evaluateResponse } = require('./grounding/groundingEvaluator');
  const scenarioId = args[0];
  const systemProfile = args[1];
  const script = args[2];
  const fixtures = getFixtures();
  const synthesized = synthesizeResponse({ scenarioId, systemProfile, script, fixtures });
  if (!synthesized.applicable) {
    printJson({ applicable: false, reason: synthesized.reason });
    return;
  }
  const scenario = fixtures.scenariosById[scenarioId];
  const evidence = {
    closet: fixtures.closetsById[scenario.closetId],
    signatureStyle: fixtures.signatureStylesById[scenario.signatureStyleId],
    commerceProduct: scenario.commerceProductId ? fixtures.commerceProductsById[scenario.commerceProductId] : null,
    commerceCatalog: fixtures.commerceCatalog,
    entitlement: { kPlusActive: scenario.kPlusActive, conciergeV1: scenario.conciergeV1 },
    scenario,
  };
  const result = evaluateResponse(synthesized.text, evidence, synthesized.groundTruth);
  printJson({ text: synthesized.text, expected: synthesized.expectedVerdicts[0], actual: result });
}

async function modeReport(args) {
  const { generateReport } = require('./reports/generateReport');
  const report = await generateReport();
  printJson({
    corpus: report.corpus,
    verdictReproductionOverall: report.verdictReproduction.overall,
    evaluatorFalsePositiveRate: report.verdictReproduction.evaluatorFalsePositiveRate,
    undecidableAccuracy: report.verdictReproduction.undecidableAccuracy,
    reportContentHash: report.reportContentHash,
  });
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.join(REPORTS_DIR, 'latest-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(`Wrote full report to ${outPath}`);

  if (args.includes('--human-review')) {
    const { getFixtures } = require('./fixtures');
    const { buildCorpus } = require('./metrics/corpusRunner');
    const { buildHumanReviewPacket } = require('./human-review/packetBuilder');
    const { cases } = buildCorpus();
    const md = buildHumanReviewPacket(cases, getFixtures());
    const mdPath = path.join(REPORTS_DIR, 'human-review-packet.md');
    fs.writeFileSync(mdPath, md);
    console.error(`Wrote human review packet to ${mdPath}`);
  }
}

function modeValidate(args) {
  // Deliberately re-exec the SEPARATE validator program rather than
  // importing/inlining it here, keeping the spec-required separation real
  // even when invoked through this single CLI entry point.
  require('./validateReport'); // registers main() via require.main check below
  process.argv = [process.argv[0], path.join(__dirname, 'validateReport.js'), ...args];
  require('node:child_process')
    .spawnSync(process.execPath, [path.join(__dirname, 'validateReport.js'), ...args], { stdio: 'inherit' });
}

async function modeL15Context() {
  const { runL15Suite } = require('./context-assembly/l15Metrics');
  printJson(await runL15Suite());
}

function modeOwnerReplay(args) {
  const { importOwnerTranscripts, corpusReadinessStatus } = require('./replay/ownerTranscriptImporter');
  const fileArg = args[0];
  if (!fileArg) {
    printJson({ status: corpusReadinessStatus(0), note: 'No owner transcript file supplied; this is the expected V1 state (spec sections 8/32/33).' });
    return;
  }
  const transcripts = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  const result = importOwnerTranscripts(Array.isArray(transcripts) ? transcripts : [transcripts]);
  printJson({ status: corpusReadinessStatus(result.imported.length), imported: result.imported.length, rejected: result.rejected });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  switch ((mode || '').toUpperCase()) {
    case 'CONTRACT':
      return modeContract();
    case 'CORPUS':
      return modeCorpus(rest);
    case 'SYNTHESIZE':
      return modeSynthesize(rest);
    case 'EVALUATE':
      return modeEvaluate(rest);
    case 'REPORT':
      return await modeReport(rest);
    case 'VALIDATE':
      return modeValidate(rest);
    case 'L1_5_CONTEXT':
      return await modeL15Context();
    case 'OWNER_REPLAY':
      return modeOwnerReplay(rest);
    default:
      console.error('Unknown or missing mode. Modes: CONTRACT | CORPUS | SYNTHESIZE | EVALUATE | REPORT | VALIDATE | L1_5_CONTEXT | OWNER_REPLAY');
      process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(2);
  });
}

module.exports = { main };
