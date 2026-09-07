'use strict';

/**
 * A small, strict RFC-4180 CSV reader (design DM-05).
 *
 * Written here rather than pulled in because the failure modes that actually
 * bite a Windows collector filling a spreadsheet are specific and worth
 * handling deliberately:
 *
 *   - Excel on Windows writes a UTF-8 BOM by default. An unhandled BOM
 *     corrupts the FIRST COLUMN HEADER only, so every row then fails on a
 *     "missing garment_id" that is plainly present on screen. Stripped here.
 *   - Excel writes CRLF. A prior lane in this repository was bitten by exactly
 *     a CRLF-versus-expected-content mismatch, so line endings are normalised
 *     rather than assumed.
 *   - A quoted field may legally contain commas, quotes ("" escapes) and
 *     newlines. A naive split(',') silently mangles any note containing a
 *     comma, which is the single most likely thing a collector types.
 *
 * Every returned row carries `sheetRow`: the 1-based row number as displayed
 * in the spreadsheet, so an error can be addressed the way a human reads it.
 */

const BOM = '﻿';

/** Tokenise CSV text into an array of raw string arrays. */
function parseCsvRows(text) {
  let input = typeof text === 'string' ? text : String(text ?? '');
  if (input.startsWith(BOM)) input = input.slice(BOM.length);
  input = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      fieldWasQuoted = false;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldWasQuoted = false;
      continue;
    }
    field += char;
  }

  // A trailing newline produces no final row; anything else does.
  if (field !== '' || fieldWasQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { rows, unterminatedQuote: inQuotes };
}

/**
 * Parse CSV text into header-keyed row objects.
 *
 * Returns { headers, rows, errors }. Structural problems (no header, an
 * unterminated quote, a row with the wrong number of cells) are reported as
 * errors rather than thrown, so a single malformed row does not cost the
 * collector the whole file.
 */
function parseCsv(text, { commentPrefix = '#' } = {}) {
  const errors = [];
  const { rows: rawRows, unterminatedQuote } = parseCsvRows(text);

  if (unterminatedQuote) {
    errors.push({
      sheetRow: null,
      column: null,
      value: null,
      message: 'the file ends inside an unterminated quoted field - check for a stray " character',
    });
  }

  // Leading comment lines let the template ship its own instructions in-file.
  let headerIndex = -1;
  for (let i = 0; i < rawRows.length; i += 1) {
    const first = (rawRows[i][0] || '').trim();
    if (first === '' && rawRows[i].every((cell) => cell.trim() === '')) continue;
    if (commentPrefix && first.startsWith(commentPrefix)) continue;
    headerIndex = i;
    break;
  }

  if (headerIndex === -1) {
    errors.push({ sheetRow: null, column: null, value: null, message: 'no header row found in the file' });
    return { headers: [], rows: [], errors };
  }

  const headers = rawRows[headerIndex].map((h) => h.trim());
  const seen = new Set();
  headers.forEach((header, index) => {
    if (header === '') {
      errors.push({
        sheetRow: headerIndex + 1,
        column: `column ${index + 1}`,
        value: '',
        message: 'header cell is empty - every column needs a name',
      });
    } else if (seen.has(header)) {
      errors.push({
        sheetRow: headerIndex + 1,
        column: header,
        value: header,
        message: `duplicate column name "${header}" - column names must be unique`,
      });
    }
    seen.add(header);
  });

  const rows = [];
  for (let i = headerIndex + 1; i < rawRows.length; i += 1) {
    const cells = rawRows[i];
    const sheetRow = i + 1;

    if (cells.every((cell) => cell.trim() === '')) continue; // blank spacer row
    if (commentPrefix && (cells[0] || '').trim().startsWith(commentPrefix)) continue;

    if (cells.length !== headers.length) {
      errors.push({
        sheetRow,
        column: null,
        value: null,
        message: `row has ${cells.length} cells but the header declares ${headers.length} - check for an extra or missing comma`,
      });
      continue;
    }

    const record = { __sheetRow: sheetRow };
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim();
    });
    rows.push(record);
  }

  return { headers, rows, errors };
}

/** Serialise rows back to CSV (used to write the template and QC exports). */
function toCsv(headers, rows) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(headers.map((header) => escape(row[header])).join(','));
  return `${lines.join('\n')}\n`;
}

module.exports = { parseCsv, parseCsvRows, toCsv, BOM };
