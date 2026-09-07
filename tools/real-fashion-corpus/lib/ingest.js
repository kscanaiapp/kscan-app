'use strict';

/**
 * Ingestion: CAPTURE -> ENTER METADATA -> VALIDATE -> INGEST -> QC -> READY
 * (mission section 23).
 *
 * Ingestion is the only place a case record acquires its asset facts. The
 * collector supplies an asset PATH; ingestion reads the actual bytes and
 * records the hash, byte size, real dimensions and EXIF verdict itself. A
 * collector-typed hash would prove nothing about what is on disk, and a
 * collector-typed "yes I stripped the GPS" would prove nothing at all - so
 * neither is accepted as input.
 *
 * Nothing is written unless the whole batch validates. A half-ingested batch
 * is a corpus that disagrees with the spreadsheet it came from.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseIntake, formatErrors } = require('./intake');
const { validateGarment, validateCase } = require('./recordSchema');
const { loadCorpus, writeGarment, writeCase, loadCorpusConfig } = require('./corpusStore');
const { inspectAsset, resolveAssetRoot } = require('./assetStore');
const { assignPartition } = require('./holdout');
const { EXIF_POLICY_VERSION, ASSET_TIER_REAL } = require('./constants');
const { PATHS } = require('./paths');

/**
 * Stage 1 - VALIDATE. Parse both sheets, apply row-level validation, apply the
 * record schemas, and check cross-sheet referential integrity. Writes nothing.
 */
function validateBatch({ garmentsCsv, casesCsv, existingCorpus }) {
  const errors = [];
  const garmentResult = garmentsCsv ? parseIntake('garments', garmentsCsv) : { records: [], errors: [] };
  const caseResult = casesCsv ? parseIntake('cases', casesCsv) : { records: [], errors: [] };

  errors.push(...garmentResult.errors.map((e) => ({ ...e, sheet: 'garments' })));
  errors.push(...caseResult.errors.map((e) => ({ ...e, sheet: 'cases' })));

  const garments = [];
  for (const { record, sheetRow, valid } of garmentResult.records) {
    if (!valid) continue;
    const schema = validateGarment(record);
    if (!schema.valid) {
      for (const message of schema.errors) {
        errors.push({ sheet: 'garments', sheetRow, column: null, value: record.garmentId, message });
      }
      continue;
    }
    garments.push(record);
  }

  const cases = [];
  for (const { record, sheetRow, valid } of caseResult.records) {
    if (!valid) continue;
    cases.push({ record, sheetRow });
  }

  // Cross-sheet: every case must name a garment present either in this batch
  // or already in the corpus.
  const knownGarmentIds = new Set([
    ...garments.map((g) => g.garmentId),
    ...(existingCorpus?.garments || []).map((g) => g.garmentId),
  ]);
  for (const { record, sheetRow } of cases) {
    if (!knownGarmentIds.has(record.garmentId)) {
      errors.push({
        sheet: 'cases',
        sheetRow,
        column: 'garment_id',
        value: record.garmentId,
        message:
          `garment "${record.garmentId}" is not in the garments sheet or already in the corpus. Add it to ` +
          'collection-template-garments.csv first - a capture cannot exist without the product it photographed.',
      });
    }
  }

  // Id collisions against the existing corpus.
  const existingGarmentIds = new Set((existingCorpus?.garments || []).map((g) => g.garmentId));
  for (const garment of garments) {
    if (existingGarmentIds.has(garment.garmentId)) {
      errors.push({
        sheet: 'garments',
        sheetRow: garment.intake?.sheetRow ?? null,
        column: 'garment_id',
        value: garment.garmentId,
        message: `garment "${garment.garmentId}" already exists in the corpus. Use a new id, or correct the existing record.`,
      });
    }
  }
  const existingCaseIds = new Set([
    ...(existingCorpus?.cases || []).map((c) => c.caseId),
  ]);
  for (const { record, sheetRow } of cases) {
    if (existingCaseIds.has(record.caseId)) {
      errors.push({
        sheet: 'cases',
        sheetRow,
        column: 'case_id',
        value: record.caseId,
        message: `case "${record.caseId}" already exists in the corpus. Use a new id.`,
      });
    }
  }

  return { garments, cases, errors, valid: errors.length === 0 };
}

/**
 * Stage 2 - INGEST. Read each asset, record what the bytes actually are, and
 * assign the deterministic partition. Still writes nothing.
 */
function prepareRecords({ garments, cases, config, options = {} }) {
  const errors = [];
  const holdoutFraction = config?.holdout?.fractionTarget ?? 0.25;
  const mount = options.assetRoot
    ? { mounted: fs.existsSync(options.assetRoot), root: options.assetRoot, source: 'explicit' }
    : resolveAssetRoot(options);

  const prepared = [];
  for (const { record, sheetRow } of cases) {
    const inspection = inspectAsset(record, { ...options, assetRoot: mount.mounted ? mount.root : undefined });

    if (inspection.status !== 'OK') {
      errors.push({
        sheet: 'cases',
        sheetRow,
        column: 'asset_path',
        value: record.asset.assetPath,
        message:
          inspection.status === 'NOT_MOUNTED'
            ? `the asset store is not mounted (looked in ${inspection.root}). Set ${'KSCAN_RFC_ASSET_ROOT'} to the ` +
              'directory holding the capture files, or place them under corpus/assets-mount/.'
            : `asset could not be ingested: ${inspection.status}`,
      });
      continue;
    }

    if (!inspection.integrity.readable) {
      errors.push({
        sheet: 'cases',
        sheetRow,
        column: 'asset_path',
        value: record.asset.assetPath,
        message: `the file is not a structurally valid image: ${inspection.integrity.findings.join(', ')}`,
      });
      continue;
    }

    // Mission section 17: an asset retaining location metadata is REJECTED,
    // never silently sanitized on the way in. Silent sanitization would mean
    // the corpus quietly rewrites a collector's evidence.
    if (inspection.metadata.locationPresent) {
      errors.push({
        sheet: 'cases',
        sheetRow,
        column: 'asset_path',
        value: record.asset.assetPath,
        message:
          `this image still carries location metadata (${inspection.metadata.locationCarriers.join(', ')}). ` +
          'Run `node tools/real-fashion-corpus/cli.js sanitize-asset <file>` and re-ingest. ' +
          'Ingestion will not strip it for you, because silently rewriting a capture is not something the corpus should do behind your back.',
      });
      continue;
    }

    if (inspection.integrity.format !== record.capture.format) {
      errors.push({
        sheet: 'cases',
        sheetRow,
        column: 'format',
        value: record.capture.format,
        message: `the file is actually a ${inspection.integrity.format}, not a ${record.capture.format}`,
      });
      continue;
    }

    const partition = assignPartition(record.garmentId, holdoutFraction);

    prepared.push({
      ...record,
      partition,
      assetTier: ASSET_TIER_REAL,
      status: 'VALID',
      asset: {
        ...record.asset,
        sha256: inspection.sha256,
        byteSize: inspection.byteSize,
        exifSanitization: {
          policyVersion: EXIF_POLICY_VERSION,
          sanitizedOn: new Date().toISOString(),
          locationStripped: true,
          verifiedCarriersAbsent: ['EXIF_GPS_IFD', 'XMP_LOCATION', 'IPTC_LOCATION'],
        },
      },
      capture: {
        ...record.capture,
        // Record what the file actually is alongside what the collector said
        // the camera produced. Mission section 15 asks for actual dimensions;
        // a stored image is the processed one, not the raw capture.
        storedDimensions: inspection.integrity.dimensions,
      },
      intake: { ...record.intake, ingestedAt: new Date().toISOString() },
    });
  }

  // Final schema pass over the completed records.
  for (const record of prepared) {
    const schema = validateCase(record);
    if (!schema.valid) {
      for (const message of schema.errors) {
        errors.push({ sheet: 'cases', sheetRow: record.intake?.sheetRow ?? null, column: null, value: record.caseId, message });
      }
    }
  }

  return { garments, cases: prepared, errors, mount };
}

/**
 * Full ingestion run.
 *
 * `dryRun: true` performs every check and reports exactly what WOULD be
 * written, without writing. That is the mode the operator dry run uses, and
 * the mode a collector should use first.
 */
function ingest({ garmentsCsv, casesCsv, dryRun = false, options = {} } = {}) {
  const existingCorpus = loadCorpus({ validate: false });
  const config = loadCorpusConfig();

  const validated = validateBatch({ garmentsCsv, casesCsv, existingCorpus });
  if (!validated.valid) {
    return {
      stage: 'VALIDATE',
      ok: false,
      written: [],
      errors: validated.errors,
      summary: 'validation failed - nothing was written',
    };
  }

  const preparedResult = prepareRecords({ garments: validated.garments, cases: validated.cases, config, options });
  if (preparedResult.errors.length > 0) {
    return {
      stage: 'INGEST',
      ok: false,
      written: [],
      errors: preparedResult.errors,
      summary: 'ingestion failed - nothing was written',
    };
  }

  const plan = {
    garments: preparedResult.garments.map((g) => ({ garmentId: g.garmentId, file: path.join(PATHS.garments, `${g.garmentId}.json`) })),
    cases: preparedResult.cases.map((c) => ({
      caseId: c.caseId,
      partition: c.partition,
      file: path.join(c.partition === 'holdout' ? PATHS.holdout : PATHS.cases, `${c.caseId}.json`),
    })),
  };

  if (dryRun) {
    return {
      stage: 'DRY_RUN',
      ok: true,
      written: [],
      wouldWrite: plan,
      errors: [],
      records: { garments: preparedResult.garments, cases: preparedResult.cases },
      summary:
        `dry run OK: would write ${plan.garments.length} garment(s) and ${plan.cases.length} case(s) ` +
        `(${plan.cases.filter((c) => c.partition === 'holdout').length} to the sealed holdout)`,
    };
  }

  const written = [];
  for (const garment of preparedResult.garments) written.push(writeGarment(garment));
  for (const record of preparedResult.cases) written.push(writeCase(record));

  return {
    stage: 'INGESTED',
    ok: true,
    written,
    errors: [],
    records: { garments: preparedResult.garments, cases: preparedResult.cases },
    summary: `ingested ${preparedResult.garments.length} garment(s) and ${preparedResult.cases.length} case(s)`,
  };
}

function formatIngestErrors(errors) {
  if (errors.length === 0) return 'No problems found.';
  const bySheet = new Map();
  for (const error of errors) {
    const sheet = error.sheet || 'file';
    if (!bySheet.has(sheet)) bySheet.set(sheet, []);
    bySheet.get(sheet).push(error);
  }
  const parts = [];
  for (const [sheet, list] of bySheet) {
    parts.push(`${sheet}:`);
    parts.push(formatErrors(list));
  }
  return parts.join('\n');
}

module.exports = { ingest, validateBatch, prepareRecords, formatIngestErrors };
