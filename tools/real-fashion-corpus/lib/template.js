'use strict';

/**
 * The collection templates are GENERATED from the column definitions in
 * intake.js, never hand-maintained. A template that has drifted from the
 * validator is worse than no template: it teaches a collector to fill in a
 * column that will be rejected.
 *
 * `writeTemplates()` writes them; `templatesAreCurrent()` checks a checked-in
 * template still matches the code, which a test asserts.
 */

const fs = require('node:fs');
const path = require('node:path');

const { GARMENT_COLUMNS, CASE_COLUMNS } = require('./intake');
const { toCsv } = require('./csv');
const { DIFFICULTY_STRATA } = require('./constants');

const INTAKE_DIR = path.join(__dirname, '..', 'intake');

const HEADER_NOTES = {
  garments: [
    '# K SCAN AI - REAL FASHION MATCH CORPUS: GARMENT COLLECTION TEMPLATE',
    '# One row per PHYSICAL PRODUCT. Photographs go in the cases template.',
    '#',
    '# GROUND-TRUTH RULE: never paste a K Scan / Gemini / Llama / any AI result',
    '# into this file. The model being evaluated may not create its own truth.',
    '# If you do not know the style code, LEAVE IT BLANK and set asserted_grade',
    '# to PARTIAL or VISUAL_ONLY. "Unknown" is a correct answer here.',
    '#',
    '# asserted_grade is your expectation. Validation derives the real grade',
    '# from the evidence you recorded and tells you if they disagree.',
    '#',
    '# Lines starting with # are ignored. Do not delete the header row.',
  ],
  cases: [
    '# K SCAN AI - REAL FASHION MATCH CORPUS: CASE (CAPTURE) COLLECTION TEMPLATE',
    '# One row per PHOTOGRAPH. Several rows may share one garment_id - that is',
    '# the point: same garment, different device or different lighting.',
    '#',
    '# PRIVACY: prefer hanger, flat-lay, mannequin or garment-only captures.',
    '# If a person is visible, human_present must be yes AND consent_status must',
    '# be EXPLICIT_COLLECTOR_CONSENT. Never photograph unrelated people.',
    '#',
    '# You do not type a file hash. Ingestion reads the actual file and records',
    '# its hash, size and EXIF status itself.',
    '#',
    `# difficulty_strata is semicolon-separated. Allowed: ${DIFFICULTY_STRATA.join('; ')}`,
    '#',
    '# Lines starting with # are ignored. Do not delete the header row.',
  ],
};

function buildTemplate(kind) {
  const columns = kind === 'garments' ? GARMENT_COLUMNS : CASE_COLUMNS;
  const notes = [...HEADER_NOTES[kind], '#', '# COLUMN GUIDE:'];
  for (const column of columns) {
    const flag = column.required ? 'REQUIRED' : 'optional';
    const allowed = column.oneOf ? ` | one of: ${column.oneOf.join(', ')}` : '';
    const help = column.help ? ` | ${column.help}` : '';
    notes.push(`#   ${column.name} (${flag})${allowed}${help}`);
  }
  notes.push('#');

  const headers = columns.map((column) => column.name);
  return `${notes.join('\n')}\n${toCsv(headers, [])}`;
}

function templatePath(kind) {
  return path.join(INTAKE_DIR, `collection-template-${kind}.csv`);
}

function writeTemplates() {
  fs.mkdirSync(INTAKE_DIR, { recursive: true });
  const written = [];
  for (const kind of ['garments', 'cases']) {
    const file = templatePath(kind);
    fs.writeFileSync(file, buildTemplate(kind), 'utf8');
    written.push(file);
  }
  return written;
}

/**
 * True when the checked-in templates match what the column definitions would
 * generate right now. Line endings are normalised before comparison because
 * git's `text=auto` attribute checks these files out as CRLF on Windows.
 */
function templatesAreCurrent() {
  const stale = [];
  for (const kind of ['garments', 'cases']) {
    const file = templatePath(kind);
    if (!fs.existsSync(file)) {
      stale.push({ kind, reason: 'template file is missing' });
      continue;
    }
    const onDisk = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== buildTemplate(kind)) {
      stale.push({ kind, reason: 'template no longer matches the column definitions in lib/intake.js' });
    }
  }
  return { current: stale.length === 0, stale };
}

module.exports = { buildTemplate, writeTemplates, templatesAreCurrent, templatePath, INTAKE_DIR };
