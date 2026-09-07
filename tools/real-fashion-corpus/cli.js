#!/usr/bin/env node
'use strict';

/**
 * Real Fashion Match Corpus - operator CLI.
 *
 * The workflow this drives is:
 *   CAPTURE -> ENTER METADATA -> VALIDATE -> INGEST -> QC -> READY
 *
 * See README.md for the operator guide and docs/COLLECTION_GUIDE.md for the
 * step-by-step walkthrough a collector follows.
 *
 * Nothing in this CLI makes a network call, touches production, or spends
 * money. `evaluate --mode REAL_HOLDOUT` is the only command that can read the
 * sealed holdout, and it refuses unless explicitly and recordedly invoked.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PATHS } = require('./lib/paths');
const { writeTemplates, templatesAreCurrent } = require('./lib/template');
const { ingest, formatIngestErrors } = require('./lib/ingest');
const { loadCorpus, buildCorpusManifest } = require('./lib/corpusStore');
const { runQc } = require('./lib/qc');
const { buildQueue, buildGapList, formatQueue } = require('./lib/queue');
const { runEvaluation } = require('./lib/evaluate');
const { validateCorpusOnDisk, validateReport, formatFindings } = require('./lib/validator');
const { inspectMetadata, stripLocationMetadata } = require('./lib/exif');
const { inspectImage } = require('./lib/imageIntegrity');
const { readInvocationLog, holdoutCaseCount, UNSEAL_ENV_VAR } = require('./lib/holdout');
const { compileCorpus } = require('./lib/compile');
const { loadReplayRecords } = require('./lib/replay');
const { realCasesOnly } = require('./lib/corpusStore');

function readIfExists(file) {
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function has(args, name) {
  return args.includes(`--${name}`);
}

/* ------------------------------------------------------------------ */

function cmdTemplate() {
  const written = writeTemplates();
  console.log('Collection templates written:');
  for (const file of written) console.log(`  ${path.relative(PATHS.repoRoot, file)}`);
  console.log('\nFill these in, drop them in intake/inbox/, then run:');
  console.log('  node tools/real-fashion-corpus/cli.js validate --garments <file> --cases <file>');
  return 0;
}

function cmdValidateIntake(args) {
  const garmentsCsv = readIfExists(flag(args, 'garments'));
  const casesCsv = readIfExists(flag(args, 'cases'));
  if (!garmentsCsv && !casesCsv) {
    console.error('Nothing to validate. Pass --garments <file> and/or --cases <file>.');
    return 2;
  }

  const result = ingest({ garmentsCsv, casesCsv, dryRun: true, options: parseAssetOptions(args) });
  if (!result.ok) {
    console.log(`VALIDATE: FAIL (stage ${result.stage})\n`);
    console.log(formatIngestErrors(result.errors));
    console.log('\nNothing was written.');
    return 1;
  }
  console.log('VALIDATE: PASS\n');
  console.log(result.summary);
  for (const item of result.wouldWrite.garments) console.log(`  garment ${item.garmentId}`);
  for (const item of result.wouldWrite.cases) console.log(`  case    ${item.caseId} -> ${item.partition}`);
  return 0;
}

function cmdIngest(args) {
  const garmentsCsv = readIfExists(flag(args, 'garments'));
  const casesCsv = readIfExists(flag(args, 'cases'));
  const dryRun = has(args, 'dry-run');

  const result = ingest({ garmentsCsv, casesCsv, dryRun, options: parseAssetOptions(args) });
  if (!result.ok) {
    console.log(`INGEST: FAIL (stage ${result.stage})\n`);
    console.log(formatIngestErrors(result.errors));
    console.log('\nNothing was written.');
    return 1;
  }
  console.log(`INGEST: ${dryRun ? 'DRY RUN OK' : 'OK'}\n${result.summary}`);
  for (const file of result.written) console.log(`  wrote ${path.relative(PATHS.repoRoot, file)}`);
  return 0;
}

function cmdQc(args) {
  const corpus = loadCorpus({ validate: false });
  const result = runQc(corpus, { requireAssets: !has(args, 'no-assets'), ...parseAssetOptions(args) });

  console.log(`QC: ${result.passed ? 'PASS' : 'FAIL'}  (policy ${result.qcPolicyVersion})`);
  console.log(`  asset storage: ${result.assets.storageStatus} (${result.assets.root})`);
  for (const [key, value] of Object.entries(result.counts)) console.log(`  ${key.padEnd(28)} ${value}`);
  if (result.findings.length > 0) {
    console.log('\nFINDINGS');
    for (const finding of result.findings) {
      const subject = finding.caseId || finding.garmentId || (finding.caseIds || []).join('+');
      console.log(`  [${finding.severity}] ${finding.code} ${subject}: ${finding.message}`);
    }
  }
  return result.passed ? 0 : 1;
}

function cmdQueue() {
  const queue = buildQueue();
  console.log(formatQueue(queue, buildGapList(queue)));
  return 0;
}

function cmdGaps() {
  const queue = buildQueue();
  const gaps = buildGapList(queue);
  console.log('PROCUREMENT / COLLECTION GAP LIST');
  console.log('='.repeat(60));
  if (gaps.length === 0) {
    console.log('No gaps: every designed claim is at least DESCRIPTIVE_ONLY.');
    return 0;
  }
  for (const gap of gaps) console.log(`P${gap.priority}  ${gap.text}`);
  return 0;
}

function cmdCompile() {
  const corpus = loadCorpus({ validate: false });
  const replay = loadReplayRecords();
  const cases = realCasesOnly(corpus.cases);
  const { fixtures, errors } = compileCorpus({ garmentsById: corpus.garmentsById, cases, replayById: replay.byCaseId });

  fs.mkdirSync(PATHS.compiledDevelopment, { recursive: true });
  for (const fixture of fixtures) {
    fs.writeFileSync(
      path.join(PATHS.compiledDevelopment, `${fixture.fixtureId}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(`COMPILE: ${errors.length === 0 ? 'OK' : 'PARTIAL'}`);
  console.log(`  ${fixtures.length} fixture(s) written to ${path.relative(PATHS.repoRoot, PATHS.compiledDevelopment)}`);
  console.log(`  replay: ${replay.status} (${replay.records.length} record(s))`);
  for (const error of errors) console.log(`  ERROR ${error.caseId}: ${error.message}`);
  return errors.length === 0 ? 0 : 1;
}

function cmdEvaluate(args) {
  const mode = flag(args, 'mode') || 'REAL_DEVELOPMENT';
  const options = {};
  if (mode === 'REAL_HOLDOUT') {
    options.holdout = { reason: flag(args, 'reason'), invokedBy: flag(args, 'invoked-by') };
  }

  let report;
  try {
    report = runEvaluation(mode, options);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const outDir = PATHS.reports;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${mode.toLowerCase()}-${report.contentHash.slice(0, 12)}.json`);
  // Never a silent overwrite (mission section 37): the filename carries the
  // content hash, so a different report cannot land on an existing one.
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`EVALUATION: ${mode}`);
  console.log(`  corpusVersion   ${report.corpusVersion}`);
  console.log(`  corpusHash      ${report.corpusHash.slice(0, 16)}...`);
  console.log(`  sourceSha       ${report.sourceSha.slice(0, 12)}`);
  console.log(`  holdoutStatus   ${report.holdoutStatus}`);
  console.log(`  cases in scope  ${report.corpus.casesInScope}`);
  console.log(`  identity n      ${report.metrics.identity.n} (${report.metrics.identity.suppressedIneligibleCases} suppressed as ineligible)`);
  console.log(`  liveMode        ${report.execution.liveMode} (spend $${report.execution.authorizedLiveEvaluationSpendUsd})`);
  console.log(`  replay          ${report.execution.replayStatus}`);
  console.log(`  claims          ${JSON.stringify(report.claimDiscipline.summary)}`);
  console.log(`  written to      ${path.relative(PATHS.repoRoot, file)}`);
  return 0;
}

function cmdValidateCorpus(args) {
  const corpusResult = validateCorpusOnDisk();
  console.log(`CORPUS VALIDATOR: ${corpusResult.passed ? 'PASS' : 'FAIL'} (${corpusResult.validatorVersion})`);
  for (const [key, value] of Object.entries(corpusResult.counts)) console.log(`  ${key.padEnd(28)} ${value}`);
  console.log(formatFindings(corpusResult));

  const reportFile = flag(args, 'report');
  if (!reportFile) return corpusResult.passed ? 0 : 1;

  if (!fs.existsSync(reportFile)) {
    console.error(`\nReport not found: ${reportFile}`);
    return 1;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (err) {
    console.log(`\nREPORT VALIDATOR: FAIL - report is not valid JSON: ${err.message}`);
    return 1;
  }
  const reportResult = validateReport(report, { corpusValidation: corpusResult });
  console.log(`\nREPORT VALIDATOR: ${reportResult.passed ? 'PASS' : 'FAIL'}`);
  console.log(formatFindings(reportResult));
  return corpusResult.passed && reportResult.passed ? 0 : 1;
}

function cmdInspectAsset(args) {
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: cli.js inspect-asset <file>');
    return 2;
  }
  const bytes = fs.readFileSync(file);
  const integrity = inspectImage(bytes);
  const metadata = inspectMetadata(bytes);

  console.log(`ASSET: ${file}`);
  console.log(`  format          ${integrity.format}`);
  console.log(`  readable        ${integrity.readable}${integrity.readable ? '' : ` (${integrity.findings.join(', ')})`}`);
  console.log(`  dimensions      ${integrity.dimensions ? `${integrity.dimensions.width}x${integrity.dimensions.height}` : 'unknown'}`);
  console.log(`  byteSize        ${integrity.byteSize}`);
  console.log(`  sha256          ${integrity.sha256}`);
  console.log(`  locationPresent ${metadata.locationPresent}${metadata.locationPresent ? ` via ${metadata.locationCarriers.join(', ')}` : ''}`);
  console.log(`  device          ${metadata.device.make || '-'} / ${metadata.device.model || '-'}`);
  console.log(`  orientation     ${metadata.orientation ?? '-'}`);
  if (metadata.locationPresent) {
    console.log('\n  This asset would be REJECTED by QC. Run:');
    console.log(`    node tools/real-fashion-corpus/cli.js sanitize-asset "${file}"`);
  }
  return metadata.locationPresent ? 1 : 0;
}

function cmdSanitizeAsset(args) {
  const file = args.find((arg) => !arg.startsWith('--'));
  const outPath = flag(args, 'out');
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: cli.js sanitize-asset <file> [--out <file>]');
    return 2;
  }
  const bytes = fs.readFileSync(file);
  const result = stripLocationMetadata(bytes);
  if (!result.ok) {
    console.error(`Refused: ${result.error}. A half-sanitized image is worse than a refused one.`);
    return 1;
  }
  const target = outPath || file;
  fs.writeFileSync(target, result.buffer);
  const after = inspectMetadata(result.buffer);
  console.log(`SANITIZED: ${target}`);
  console.log(`  removed            ${result.removed.join(', ') || '(nothing to remove)'}`);
  console.log(`  orientation kept   ${result.preservedOrientation ?? '-'}`);
  console.log(`  locationPresent    ${after.locationPresent}`);
  return after.locationPresent ? 1 : 0;
}

function cmdHoldoutStatus() {
  console.log('HOLDOUT');
  console.log(`  status            SEALED`);
  console.log(`  cases             ${holdoutCaseCount()}`);
  console.log(`  unseal env var    ${UNSEAL_ENV_VAR}`);
  console.log(`  invocation log    ${path.relative(PATHS.repoRoot, PATHS.holdoutInvocationLog)}`);
  const log = readInvocationLog();
  console.log(`  recorded unseals  ${log.length}`);
  for (const entry of log) {
    console.log(`    ${entry.unsealedAt} by ${entry.invokedBy}: ${entry.reason} (${entry.caseCount} case(s))`);
  }
  return 0;
}

function cmdManifest() {
  const corpus = loadCorpus({ validate: false });
  const manifest = buildCorpusManifest(corpus);
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

function cmdCheckTemplates() {
  const result = templatesAreCurrent();
  console.log(`TEMPLATES: ${result.current ? 'CURRENT' : 'STALE'}`);
  for (const item of result.stale) console.log(`  ${item.kind}: ${item.reason}`);
  return result.current ? 0 : 1;
}

function parseAssetOptions(args) {
  const assetRoot = flag(args, 'asset-root');
  return assetRoot ? { assetRoot: path.resolve(assetRoot) } : {};
}

const COMMANDS = {
  template: cmdTemplate,
  validate: cmdValidateIntake,
  ingest: cmdIngest,
  qc: cmdQc,
  queue: cmdQueue,
  gaps: cmdGaps,
  compile: cmdCompile,
  evaluate: cmdEvaluate,
  'validate-corpus': cmdValidateCorpus,
  'inspect-asset': cmdInspectAsset,
  'sanitize-asset': cmdSanitizeAsset,
  'holdout-status': cmdHoldoutStatus,
  manifest: cmdManifest,
  'check-templates': cmdCheckTemplates,
};

function usage() {
  console.log(`Real Fashion Match Corpus - operator CLI

  WORKFLOW: capture -> enter metadata -> validate -> ingest -> qc -> ready

  template                       write the fillable collection templates
  validate --garments F --cases F  check a filled sheet; writes nothing
  ingest   --garments F --cases F  ingest a validated batch  [--dry-run]
  qc                             run corpus QC               [--no-assets]
  queue                          the live collection queue + gap list
  gaps                           the gap list on its own
  compile                        compile cases into FMQL fixtures
  evaluate --mode MODE           REAL_DEVELOPMENT (default) | PAIRED_DEVICE | REAL_HOLDOUT
                                 REAL_HOLDOUT also needs --reason and --invoked-by,
                                 plus ${UNSEAL_ENV_VAR} in the environment
  validate-corpus [--report F]   the INDEPENDENT validator
  inspect-asset FILE             integrity + embedded-metadata report for one file
  sanitize-asset FILE [--out F]  strip location metadata, keep orientation
  holdout-status                 seal state and recorded unseals
  manifest                       the corpus manifest, as JSON
  check-templates                are the checked-in templates current

  Common: --asset-root DIR       where the real capture bytes are mounted

  No command here makes a network call, touches production, or spends money.`);
}

function main() {
  const [, , command, ...args] = process.argv;
  if (!command || command === 'help' || command === '--help') {
    usage();
    process.exit(command ? 0 : 2);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    usage();
    process.exit(2);
  }
  process.exit(handler(args) ?? 0);
}

if (require.main === module) main();

module.exports = { COMMANDS };
