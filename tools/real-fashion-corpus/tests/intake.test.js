'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCsv, toCsv, BOM } = require('../lib/csv');
const { parseIntake, formatErrors, GARMENT_COLUMNS, CASE_COLUMNS } = require('../lib/intake');
const { templatesAreCurrent, buildTemplate } = require('../lib/template');
const { validateGarment, validateCase } = require('../lib/recordSchema');

/* ------------------------------------------------------------------ *
 * CSV reader
 * ------------------------------------------------------------------ */

test('CSV: a UTF-8 BOM does not corrupt the first column header', () => {
  // Excel on Windows writes a BOM by default. Unhandled, it breaks ONLY the
  // first header, so every row fails on a field that is plainly present.
  const { headers, rows } = parseCsv(`${BOM}garment_id,category\nG001,top\n`);
  assert.deepEqual(headers, ['garment_id', 'category']);
  assert.equal(rows[0].garment_id, 'G001');
});

test('CSV: CRLF line endings parse identically to LF', () => {
  const lf = parseCsv('a,b\n1,2\n');
  const crlf = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(crlf.rows[0].a, lf.rows[0].a);
  assert.deepEqual(crlf.rows[0].b, '2');
});

test('CSV: a quoted field may contain commas, quotes and newlines', () => {
  const { rows } = parseCsv('a,b\n"one, two","he said ""hi""\nsecond line"\n');
  assert.equal(rows[0].a, 'one, two');
  assert.equal(rows[0].b, 'he said "hi"\nsecond line');
});

test('CSV: a row with the wrong cell count is reported by spreadsheet row number', () => {
  const { errors } = parseCsv('a,b,c\n1,2\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].sheetRow, 2);
  assert.match(errors[0].message, /2 cells but the header declares 3/);
});

test('CSV: an unterminated quote is reported rather than silently swallowing the file', () => {
  const { errors } = parseCsv('a,b\n"oops,2\n');
  assert.ok(errors.some((e) => /unterminated quoted field/.test(e.message)));
});

test('CSV: comment lines and blank rows are skipped, not treated as data', () => {
  const { rows } = parseCsv('# a note\n\na,b\n1,2\n# trailing note\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, '1');
});

test('CSV: round-trips values that need quoting', () => {
  const text = toCsv(['a', 'b'], [{ a: 'x,y', b: 'has "quotes"' }]);
  const { rows } = parseCsv(text);
  assert.equal(rows[0].a, 'x,y');
  assert.equal(rows[0].b, 'has "quotes"');
});

/* ------------------------------------------------------------------ *
 * Templates stay in step with the validator
 * ------------------------------------------------------------------ */

test('TEMPLATE: the checked-in templates match the column definitions', () => {
  // A template that has drifted from the validator teaches a collector to fill
  // in a column that will be rejected.
  const result = templatesAreCurrent();
  assert.equal(result.current, true, `stale: ${JSON.stringify(result.stale)}`);
});

test('TEMPLATE: every column appears in the generated template header and guide', () => {
  for (const [kind, columns] of [['garments', GARMENT_COLUMNS], ['cases', CASE_COLUMNS]]) {
    const text = buildTemplate(kind);
    for (const column of columns) {
      assert.ok(text.includes(`#   ${column.name} (`), `${kind}: ${column.name} missing from the column guide`);
    }
    const headerLine = text.split('\n').find((line) => !line.startsWith('#') && line.trim() !== '');
    assert.deepEqual(headerLine.split(','), columns.map((c) => c.name));
  }
});

test('TEMPLATE: an empty template parses cleanly with zero rows and zero errors', () => {
  for (const kind of ['garments', 'cases']) {
    const { records, errors } = parseIntake(kind, buildTemplate(kind));
    assert.deepEqual(records, [], `${kind} produced rows from an empty template`);
    assert.deepEqual(errors, [], `${kind} errors: ${formatErrors(errors)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Row-level validation (mission section 23, invariant 42.11)
 * ------------------------------------------------------------------ */

const GARMENT_HEADER = GARMENT_COLUMNS.map((c) => c.name).join(',');
const CASE_HEADER = CASE_COLUMNS.map((c) => c.name).join(',');

function garmentRow(overrides = {}) {
  const base = {
    garment_id: 'G001',
    category: 'outerwear',
    collector_id: 'COL-01',
    collection_source: 'OWNER_TEAM_GARMENT',
    store_policy_respected: '',
    brand: 'Test Brand',
    product_name: 'Quilted Jacket',
    style_code: 'TB-QJ-1200',
    gtin: '0123456789012',
    colorway_name: 'Deep Navy',
    colorway_code: 'NVY-401',
    size: 'M',
    asserted_grade: 'IDENTIFIER_GRADE',
    evidence_type: 'MANUFACTURER_TAG',
    evidence_verified_on: '2026-09-01',
    evidence_verified_by: 'COL-01',
    evidence_observed_facts: 'brandOnTag=Test Brand; styleCodeOnTag=TB-QJ-1200',
    evidence_url: '',
    catalog_state_verified_on: '2026-09-01',
    attr_silhouette: 'boxy',
    attr_material: 'polyester',
    attr_pattern: 'solid',
    attr_color_family: 'navy',
    attr_price_tier: 'mid',
    attr_gender_presentation: 'unisex',
    notes: '',
  };
  return { ...base, ...overrides };
}

function caseRow(overrides = {}) {
  const base = {
    case_id: 'C0001',
    garment_id: 'G001',
    device_platform: 'ios',
    device_model: 'iPhone 15 Pro',
    capture_profile: 'ios-current-v1',
    capture_type: 'HANGER',
    capture_environment: 'INDOOR_ARTIFICIAL',
    captured_on: '2026-09-01',
    captured_width: '4032',
    captured_height: '3024',
    format: 'jpeg',
    human_present: 'no',
    consent_status: '',
    asset_path: 'G001/C0001-ios.jpg',
    paired_case_id: '',
    input_hard_negative_of: '',
    difficulty_strata: 'NO_VISIBLE_LOGO;DARK_GARMENT',
    notes: '',
  };
  return { ...base, ...overrides };
}

function sheet(kind, rows) {
  const columns = kind === 'garments' ? GARMENT_COLUMNS : CASE_COLUMNS;
  const header = kind === 'garments' ? GARMENT_HEADER : CASE_HEADER;
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const value = row[c.name] ?? '';
        return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      })
      .join(','),
  );
  return `${header}\n${lines.join('\n')}\n`;
}

test('INTAKE: a well-formed garment row produces a schema-valid garment record', () => {
  const { records, errors } = parseIntake('garments', sheet('garments', [garmentRow()]));
  assert.deepEqual(errors, [], formatErrors(errors));
  assert.equal(records.length, 1);
  assert.equal(records[0].valid, true);
  const schemaResult = validateGarment(records[0].record);
  assert.equal(schemaResult.valid, true, schemaResult.errors.join('; '));
});

test('INTAKE: a well-formed case row produces a case record that validates once ingestion fills the asset facts', () => {
  const { records, errors } = parseIntake('cases', sheet('cases', [caseRow()]));
  assert.deepEqual(errors, [], formatErrors(errors));
  const record = records[0].record;
  // A collector never types a hash; a typed hash proves nothing about the
  // bytes on disk. Ingestion supplies these from the file itself.
  assert.equal(record.asset.sha256, undefined);
  record.asset.sha256 = 'a'.repeat(64);
  record.asset.byteSize = 100;
  record.asset.exifSanitization.locationStripped = true;
  record.asset.exifSanitization.sanitizedOn = '2026-09-01T00:00:00.000Z';
  const schemaResult = validateCase(record);
  assert.equal(schemaResult.valid, true, schemaResult.errors.join('; '));
});

test('INTAKE: a missing required cell reports row, column, and what was expected', () => {
  const { errors } = parseIntake('garments', sheet('garments', [garmentRow({ collector_id: '' })]));
  const error = errors.find((e) => e.column === 'collector_id');
  assert.ok(error, `expected a collector_id error, got: ${formatErrors(errors)}`);
  assert.equal(error.sheetRow, 2, 'must address the row the way the spreadsheet numbers it');
  assert.match(error.message, /required/);
  assert.match(error.message, /COL-01/, 'the message should carry the column help text');
});

test('INTAKE: pasting a scanner or AI result as evidence is refused, and the message says why', () => {
  // This is the most consequential mistake a collector can make, so the error
  // has to teach rather than just reject.
  for (const bad of ['KSCAN_RESULT', 'GEMINI_OUTPUT', 'LLM_GENERATED_SKU']) {
    const { errors } = parseIntake('garments', sheet('garments', [garmentRow({ evidence_type: bad })]));
    const error = errors.find((e) => e.column === 'evidence_type');
    assert.ok(error, `${bad}: expected an evidence_type error`);
    assert.match(error.message, /model-generated and can never be ground truth/);
    assert.match(error.message, /VISUAL_ONLY/, 'the message must offer the honest alternative');
  }
});

test('INTAKE: a bad date is rejected with the offending value quoted back', () => {
  const { errors } = parseIntake('garments', sheet('garments', [garmentRow({ evidence_verified_on: '01/09/2026' })]));
  const error = errors.find((e) => e.column === 'evidence_verified_on');
  assert.match(error.message, /not a date in YYYY-MM-DD form/);
  assert.equal(error.value, '01/09/2026');
});

test('INTAKE: an impossible calendar date is rejected even though it matches the pattern', () => {
  const { errors } = parseIntake('garments', sheet('garments', [garmentRow({ evidence_verified_on: '2026-02-30' })]));
  assert.ok(errors.some((e) => e.column === 'evidence_verified_on' && /not a real calendar date/.test(e.message)));
});

test('INTAKE: observed facts must be key=value, and an empty cell explains why it matters', () => {
  const { errors } = parseIntake('garments', sheet('garments', [garmentRow({ evidence_observed_facts: 'just some prose' })]));
  const error = errors.find((e) => e.column === 'evidence_observed_facts');
  assert.ok(error);
  assert.match(error.message, /key=value/);
});

test('INTAKE: a duplicate id names the row it collides with', () => {
  const { errors } = parseIntake('garments', sheet('garments', [garmentRow(), garmentRow()]));
  const error = errors.find((e) => e.column === 'garment_id');
  assert.ok(error);
  assert.match(error.message, /already used on row 2/);
  assert.equal(error.sheetRow, 3);
});

test('INTAKE: an unknown difficulty stratum lists the allowed values', () => {
  const { errors } = parseIntake('cases', sheet('cases', [caseRow({ difficulty_strata: 'DARK_GARMENT;SPARKLY' })]));
  const error = errors.find((e) => e.column === 'difficulty_strata');
  assert.match(error.message, /unknown value\(s\): SPARKLY/);
  assert.match(error.message, /Allowed:/);
});

test('INTAKE: a person in frame without recorded consent is refused with the privacy rule quoted', () => {
  const { errors } = parseIntake('cases', sheet('cases', [caseRow({ human_present: 'yes', capture_type: 'WORN' })]));
  const error = errors.find((e) => e.column === 'consent_status');
  assert.ok(error);
  assert.match(error.message, /EXPLICIT_COLLECTOR_CONSENT/);
  assert.match(error.message, /hanger, flat-lay, mannequin or garment-only/);
});

test('INTAKE: yes/no columns accept the words a human actually types', () => {
  for (const word of ['yes', 'Yes', 'Y', 'true', '1']) {
    const { records, errors } = parseIntake('cases', sheet('cases', [caseRow({ human_present: word, consent_status: 'EXPLICIT_COLLECTOR_CONSENT' })]));
    assert.deepEqual(errors, [], `${word}: ${formatErrors(errors)}`);
    assert.equal(records[0].record.capture.consent.humanPresent, true, word);
  }
  for (const word of ['no', 'No', 'N', 'false', '0']) {
    const { records } = parseIntake('cases', sheet('cases', [caseRow({ human_present: word })]));
    assert.equal(records[0].record.capture.consent.humanPresent, false, word);
  }
  const { errors } = parseIntake('cases', sheet('cases', [caseRow({ human_present: 'maybe' })]));
  assert.ok(errors.some((e) => e.column === 'human_present' && /not yes\/no/.test(e.message)));
});

test('INTAKE: EVERY bad row is reported in one pass, not just the first', () => {
  // Otherwise a collector fixes one row, re-runs, and discovers the next.
  const rows = [
    garmentRow({ garment_id: 'G001', collector_id: '' }),
    garmentRow({ garment_id: 'G002', evidence_verified_on: 'nope' }),
    garmentRow({ garment_id: 'G003', category: 'spaceship' }),
  ];
  const { errors } = parseIntake('garments', sheet('garments', rows));
  assert.deepEqual([...new Set(errors.map((e) => e.sheetRow))].sort(), [2, 3, 4]);
});

test('INTAKE: a good row alongside bad rows still yields a valid record', () => {
  const rows = [garmentRow({ garment_id: 'G001' }), garmentRow({ garment_id: 'G002', collector_id: '' })];
  const { records } = parseIntake('garments', sheet('garments', rows));
  assert.equal(records[0].valid, true);
  assert.equal(records[1].valid, false);
});

test('INTAKE: a file missing a whole column points the collector back at the template', () => {
  const { errors } = parseIntake('garments', 'garment_id,category\nG001,top\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /missing required column\(s\)/);
  assert.match(errors[0].message, /collection-template-garments\.csv/);
});

test('INTAKE: formatErrors renders an address a human can act on', () => {
  const { errors } = parseIntake('garments', sheet('garments', [garmentRow({ collector_id: '' })]));
  const text = formatErrors(errors);
  assert.match(text, /row 2, column "collector_id"/);
});

test('INTAKE: intake never produces a PIPELINE_TEST_ASSET case', () => {
  // The collection workflow only ever creates real captures; test assets are
  // built by testAssets/generate.js and live only in test paths.
  const { records } = parseIntake('cases', sheet('cases', [caseRow()]));
  assert.equal(records[0].record.assetTier, 'REAL_CAPTURE');
  assert.equal(records[0].record.pipelineTestPurpose, undefined);
});
