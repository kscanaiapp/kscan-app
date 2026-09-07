'use strict';

/**
 * Collection intake: spreadsheet row -> corpus record (mission section 23).
 *
 * The human workflow is a first-class deliverable, so this module's real
 * output is not the records - it is the ERRORS. Every error carries the
 * 1-based spreadsheet row, the column name, the offending value, and what was
 * expected, because that is the difference between a collector fixing a
 * garment in thirty seconds and giving up.
 *
 * Two templates, mirroring the two record types (design DM-08):
 *   garments.csv - one row per physical product identity + its ground truth
 *   cases.csv    - one row per capture, referencing a garment_id
 *
 * A collector never edits source code to add a garment.
 */

const { parseCsv } = require('./csv');
const {
  GARMENT_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  EXIF_POLICY_VERSION,
  ASSET_TIER_REAL,
  ALLOWED_EVIDENCE_TYPES,
  FORBIDDEN_EVIDENCE_TYPES,
  COLLECTION_SOURCES,
  CATEGORIES,
  CAPTURE_TYPES,
  CAPTURE_ENVIRONMENTS,
  CAPTURE_PROFILES,
  PLATFORMS,
  IMAGE_FORMATS,
  DIFFICULTY_STRATA,
  GROUND_TRUTH_GRADES,
} = require('./constants');

/* ------------------------------------------------------------------ *
 * Column definitions - these ARE the template
 * ------------------------------------------------------------------ */

const GARMENT_COLUMNS = [
  { name: 'garment_id', required: true, help: 'G001, G002, ... unique per physical product' },
  { name: 'category', required: true, oneOf: CATEGORIES },
  { name: 'collector_id', required: true, help: 'who collected this, e.g. COL-01' },
  { name: 'collection_source', required: true, oneOf: COLLECTION_SOURCES },
  { name: 'store_policy_respected', required: false, boolean: true, help: 'yes/no - REQUIRED yes for AUTHORIZED_IN_STORE' },
  { name: 'brand', required: false, help: 'brand as printed on the tag' },
  { name: 'product_name', required: false, help: 'manufacturer product name' },
  { name: 'style_code', required: false, help: 'manufacturer style/model code - a DURABLE identifier' },
  { name: 'gtin', required: false, help: 'UPC/EAN barcode digits - a DURABLE identifier' },
  { name: 'colorway_name', required: false, help: 'colourway as named by the manufacturer' },
  { name: 'colorway_code', required: false },
  { name: 'size', required: false },
  { name: 'asserted_grade', required: true, oneOf: GROUND_TRUTH_GRADES, help: 'your expectation; checked against the evidence' },
  { name: 'evidence_type', required: true, oneOf: ALLOWED_EVIDENCE_TYPES, help: 'where the truth came from - never a scanner/AI result' },
  { name: 'evidence_verified_on', required: true, date: true, help: 'YYYY-MM-DD' },
  { name: 'evidence_verified_by', required: true, help: 'collector id who checked it' },
  {
    name: 'evidence_observed_facts',
    required: true,
    keyValues: true,
    help: 'facts read off the tag/page, as key=value; key=value. This is what survives the URL dying.',
  },
  { name: 'evidence_url', required: false, help: 'optional supplementary pointer; never the only evidence' },
  { name: 'catalog_state_verified_on', required: true, date: true, help: 'YYYY-MM-DD the catalogue was checked' },
  { name: 'attr_silhouette', required: false },
  { name: 'attr_material', required: false },
  { name: 'attr_pattern', required: false },
  { name: 'attr_color_family', required: false },
  { name: 'attr_price_tier', required: false, help: 'value / mid / premium / luxury' },
  { name: 'attr_gender_presentation', required: false, help: 'womens / mens / unisex - presentation of the GARMENT, never of a person' },
  { name: 'notes', required: false },
];

const CASE_COLUMNS = [
  { name: 'case_id', required: true, help: 'C0001, C0002, ... unique per capture' },
  { name: 'garment_id', required: true, help: 'which garment this photographed' },
  { name: 'device_platform', required: true, oneOf: PLATFORMS },
  { name: 'device_model', required: true, help: 'e.g. iPhone 15 Pro' },
  { name: 'capture_profile', required: true, oneOf: CAPTURE_PROFILES },
  { name: 'capture_type', required: true, oneOf: CAPTURE_TYPES, help: 'prefer HANGER / FLAT_LAY / MANNEQUIN / GARMENT_ONLY' },
  { name: 'capture_environment', required: true, oneOf: CAPTURE_ENVIRONMENTS },
  { name: 'captured_on', required: true, date: true, help: 'YYYY-MM-DD' },
  { name: 'captured_width', required: true, integer: true },
  { name: 'captured_height', required: true, integer: true },
  { name: 'format', required: true, oneOf: IMAGE_FORMATS },
  { name: 'human_present', required: true, boolean: true, help: 'yes/no - is a person visible in the frame' },
  { name: 'consent_status', required: false, help: 'EXPLICIT_COLLECTOR_CONSENT when a person is visible' },
  { name: 'asset_path', required: true, help: 'path inside the mounted asset root, e.g. G001/C0001-ios.jpg' },
  { name: 'paired_case_id', required: false, help: 'the other platform capture of the SAME garment' },
  { name: 'input_hard_negative_of', required: false, help: 'a DIFFERENT garment_id this capture is easy to confuse with' },
  { name: 'difficulty_strata', required: false, list: true, help: 'semicolon-separated, from the documented list' },
  { name: 'notes', required: false },
];

/* ------------------------------------------------------------------ *
 * Cell coercion + validation
 * ------------------------------------------------------------------ */

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function rowError(row, column, value, message) {
  return { sheetRow: row.__sheetRow, column, value, message };
}

/**
 * Parse a `key=value; key=value` cell. This is how a collector records what
 * they actually read off a tag without needing a nested data format in a
 * spreadsheet cell.
 */
function parseKeyValues(text) {
  const out = {};
  const problems = [];
  for (const chunk of String(text).split(';')) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      problems.push(`"${trimmed}" is not key=value`);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === '' || value === '') {
      problems.push(`"${trimmed}" has an empty key or value`);
      continue;
    }
    out[key] = value;
  }
  return { values: out, problems };
}

function coerceCell(row, column, errors) {
  const raw = row[column.name];

  if (raw === undefined) {
    errors.push(rowError(row, column.name, null, `column "${column.name}" is missing from the file`));
    return undefined;
  }

  if (raw === '') {
    if (column.required) {
      errors.push(
        rowError(row, column.name, '', `"${column.name}" is required${column.help ? ` (${column.help})` : ''}`),
      );
    }
    return undefined;
  }

  if (column.oneOf) {
    if (!column.oneOf.includes(raw)) {
      // Naming the forbidden case explicitly is far more useful than
      // "not in the allowed list" when a collector pastes a scanner result.
      if (FORBIDDEN_EVIDENCE_TYPES.includes(raw)) {
        errors.push(
          rowError(
            row,
            column.name,
            raw,
            `"${raw}" is model-generated and can never be ground truth. The model being evaluated may not create ` +
              'its own truth (mission section 5). Use a manufacturer tag, product page, retailer PDP, barcode, ' +
              'purchase record, or direct owner knowledge - or leave the identifiers blank and let the grade be VISUAL_ONLY.',
          ),
        );
        return undefined;
      }
      errors.push(
        rowError(row, column.name, raw, `"${raw}" is not allowed. Use one of: ${column.oneOf.join(', ')}`),
      );
      return undefined;
    }
    return raw;
  }

  if (column.boolean) {
    const lower = raw.toLowerCase();
    if (TRUE_WORDS.has(lower)) return true;
    if (FALSE_WORDS.has(lower)) return false;
    errors.push(rowError(row, column.name, raw, `"${raw}" is not yes/no`));
    return undefined;
  }

  if (column.integer) {
    if (!/^\d+$/.test(raw)) {
      errors.push(rowError(row, column.name, raw, `"${raw}" is not a whole number`));
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    if (value <= 0) {
      errors.push(rowError(row, column.name, raw, `"${raw}" must be greater than zero`));
      return undefined;
    }
    return value;
  }

  if (column.date) {
    if (!ISO_DATE.test(raw)) {
      errors.push(rowError(row, column.name, raw, `"${raw}" is not a date in YYYY-MM-DD form`));
      return undefined;
    }
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      errors.push(rowError(row, column.name, raw, `"${raw}" is not a real calendar date`));
      return undefined;
    }
    return raw;
  }

  if (column.keyValues) {
    const { values, problems } = parseKeyValues(raw);
    for (const problem of problems) {
      errors.push(rowError(row, column.name, raw, `${problem}. Expected: key=value; key=value`));
    }
    if (Object.keys(values).length === 0) {
      errors.push(
        rowError(
          row,
          column.name,
          raw,
          'record at least one observed fact, e.g. "brandOnTag=Acme; styleCodeOnTag=AC-1200". ' +
            'These facts are what keeps the record readable after the retailer page disappears.',
        ),
      );
      return undefined;
    }
    return values;
  }

  if (column.list) {
    const items = raw
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);
    const unknown = items.filter((item) => !DIFFICULTY_STRATA.includes(item));
    if (unknown.length > 0) {
      errors.push(
        rowError(
          row,
          column.name,
          raw,
          `unknown value(s): ${unknown.join(', ')}. Allowed: ${DIFFICULTY_STRATA.join(', ')}`,
        ),
      );
      return undefined;
    }
    return items;
  }

  return raw;
}

/* ------------------------------------------------------------------ *
 * Row -> record
 * ------------------------------------------------------------------ */

function buildGarmentFromRow(row, errors) {
  const values = {};
  for (const column of GARMENT_COLUMNS) values[column.name] = coerceCell(row, column, errors);

  const evidence = {
    evidenceType: values.evidence_type,
    verifiedOn: values.evidence_verified_on,
    verifiedBy: values.evidence_verified_by,
    observedFacts: values.evidence_observed_facts,
  };
  if (values.evidence_url) evidence.urlPointer = values.evidence_url;

  const style = {};
  if (values.brand) style.brand = values.brand;
  if (values.product_name) style.productName = values.product_name;
  if (values.style_code) style.styleCode = values.style_code;

  const variant = {};
  if (values.colorway_name) variant.colorwayName = values.colorway_name;
  if (values.colorway_code) variant.colorwayCode = values.colorway_code;
  if (values.gtin) variant.gtin = values.gtin;
  if (values.size) variant.size = values.size;

  const collection = { collectorId: values.collector_id, source: values.collection_source };
  if (values.store_policy_respected !== undefined) collection.storePolicyRespected = values.store_policy_respected;

  const attributes = {};
  if (values.attr_silhouette) attributes.silhouette = values.attr_silhouette;
  if (values.attr_material) attributes.material = values.attr_material;
  if (values.attr_pattern) attributes.pattern = values.attr_pattern;
  if (values.attr_color_family) attributes.colorFamily = values.attr_color_family;
  if (values.attr_price_tier) attributes.priceTier = values.attr_price_tier;
  if (values.attr_gender_presentation) attributes.genderPresentation = values.attr_gender_presentation;

  const garment = {
    recordType: 'GARMENT',
    schemaVersion: GARMENT_SCHEMA_VERSION,
    garmentId: values.garment_id,
    category: values.category,
    collection,
    groundTruth: {
      assertedGrade: values.asserted_grade,
      identity: { style, variant },
      evidence: [evidence],
      catalogStateVerifiedOn: values.catalog_state_verified_on,
    },
    attributes,
    revisions: [],
    intake: { sheetRow: row.__sheetRow },
  };
  if (values.notes) garment.notes = values.notes;
  return garment;
}

function buildCaseFromRow(row, errors) {
  const values = {};
  for (const column of CASE_COLUMNS) values[column.name] = coerceCell(row, column, errors);

  const humanPresent = values.human_present === true;
  const consentStatus = values.consent_status || (humanPresent ? undefined : 'NOT_APPLICABLE');

  if (humanPresent && !values.consent_status) {
    errors.push(
      rowError(
        row,
        'consent_status',
        '',
        'a capture with a person visible requires consent_status = EXPLICIT_COLLECTOR_CONSENT (mission section 16). ' +
          'Prefer a hanger, flat-lay, mannequin or garment-only capture instead.',
      ),
    );
  }

  const record = {
    recordType: 'CASE',
    schemaVersion: CASE_SCHEMA_VERSION,
    caseId: values.case_id,
    garmentId: values.garment_id,
    // Intake always produces REAL_CAPTURE. A pipeline-test asset is never
    // created through the collection workflow (mission section 26).
    assetTier: ASSET_TIER_REAL,
    status: 'QC_PENDING',
    partition: 'development', // reassigned deterministically at ingest
    capture: {
      device: { platform: values.device_platform, model: values.device_model },
      captureProfile: values.capture_profile,
      captureType: values.capture_type,
      environment: values.capture_environment,
      capturedOn: values.captured_on,
      capturedDimensions:
        values.captured_width && values.captured_height
          ? { width: values.captured_width, height: values.captured_height }
          : undefined,
      format: values.format,
      consent: { humanPresent, consentStatus },
    },
    asset: {
      assetPath: values.asset_path,
      // sha256 / byteSize / EXIF attestation are filled by ingestion from the
      // actual file. A collector never types a hash - a typed hash proves
      // nothing about the bytes on disk.
      exifSanitization: { policyVersion: EXIF_POLICY_VERSION },
    },
    intake: { sheetRow: row.__sheetRow },
  };

  if (values.paired_case_id) record.pairing = { pairedCaseId: values.paired_case_id };
  if (values.input_hard_negative_of) record.inputHardNegativeOf = values.input_hard_negative_of;
  if (values.difficulty_strata) record.difficultyStrata = values.difficulty_strata;
  if (values.notes) record.notes = values.notes;
  return record;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function parseIntake(kind, text) {
  const columns = kind === 'garments' ? GARMENT_COLUMNS : CASE_COLUMNS;
  const build = kind === 'garments' ? buildGarmentFromRow : buildCaseFromRow;

  const { headers, rows, errors: structural } = parseCsv(text);
  const errors = [...structural];

  const missingColumns = columns.filter((c) => !headers.includes(c.name)).map((c) => c.name);
  if (missingColumns.length > 0) {
    errors.push({
      sheetRow: null,
      column: null,
      value: null,
      message: `the file is missing required column(s): ${missingColumns.join(', ')}. Start from intake/collection-template-${kind}.csv`,
    });
    return { records: [], errors, rowCount: rows.length };
  }

  const records = [];
  const idField = kind === 'garments' ? 'garment_id' : 'case_id';
  const seenIds = new Map();

  for (const row of rows) {
    const rowErrors = [];
    const record = build(row, rowErrors);

    const id = row[idField];
    if (id) {
      if (seenIds.has(id)) {
        rowErrors.push(
          rowError(row, idField, id, `"${id}" is already used on row ${seenIds.get(id)} - ids must be unique`),
        );
      } else {
        seenIds.set(id, row.__sheetRow);
      }
    }

    errors.push(...rowErrors);
    // A row with errors still yields its record so the caller can report every
    // problem across the whole sheet in one pass, rather than making the
    // collector fix one row, re-run, and discover the next.
    records.push({ record, sheetRow: row.__sheetRow, valid: rowErrors.length === 0 });
  }

  return { records, errors, rowCount: rows.length };
}

/** Render the errors the way a collector should read them. */
function formatErrors(errors) {
  if (errors.length === 0) return 'No problems found.';
  return errors
    .map((e) => {
      const where = e.sheetRow ? `row ${e.sheetRow}` : 'file';
      const what = e.column ? `, column "${e.column}"` : '';
      const got = e.value !== null && e.value !== undefined && e.value !== '' ? ` (got "${e.value}")` : '';
      return `  ${where}${what}${got}: ${e.message}`;
    })
    .join('\n');
}

module.exports = {
  GARMENT_COLUMNS,
  CASE_COLUMNS,
  parseIntake,
  formatErrors,
  parseKeyValues,
};
