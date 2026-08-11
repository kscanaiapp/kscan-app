#!/usr/bin/env node
/**
 * Scanner prompt budget measurement (Phase 7.2 §4, §20).
 *
 * Extracts the scanner's provider prompts straight from `scan-identify/index.ts`
 * and reports their size, so a prompt refactor can be shown to be net-neutral
 * rather than merely claimed to be.
 *
 * ON TOKEN COUNTS — STATED HONESTLY: there is no offline Gemini tokenizer in
 * this repository, so an exact provider token count cannot be produced here.
 * This reports:
 *
 *   chars       — exact and unambiguous ground truth
 *   approxTokens— chars/4, the conventional rough ratio, clearly LABELLED as an
 *                 approximation and never presented as a provider count
 *
 * A delta in `chars` is exact. A delta in `approxTokens` is indicative. Both are
 * reported so the reader can tell which is which — quoting only an
 * approximation as though it were measured is exactly the Phase 6 accounting
 * mistake this build is told not to repeat.
 *
 * Usage:
 *   node scripts/scanner-prompt-budget.js                 # human table
 *   node scripts/scanner-prompt-budget.js --json          # machine readable
 *   node scripts/scanner-prompt-budget.js --baseline <f>  # compare to a saved --json
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_REL = 'supabase/functions/scan-identify/index.ts';

/**
 * The prompt constants that are actually sent to the provider on a scan.
 * `withQualityAndRoute` composes the addendum and the category route onto the
 * base prompt, so the addendum is measured as its own line item.
 */
const PROMPT_CONSTS = [
  'IDENTIFY_PROMPT',
  'MULTI_ITEM_IDENTIFY_PROMPT',
  'TEXT_IDENTIFY_PROMPT',
  'QUALITY_TUNE_PROMPT_ADDENDUM',
];

/** Extracts `const NAME = \`...\`;` from the source, respecting nested braces. */
function extractTemplateConst(source, name) {
  const marker = `const ${name} = \``;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const bodyStart = start + marker.length;
  // Walk to the closing backtick, honouring escaped backticks.
  let i = bodyStart;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') break;
    i += 1;
  }
  if (i >= source.length) return null;
  return source.slice(bodyStart, i);
}

function measure(text) {
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = text.split('\n').length;
  return {
    chars,
    words,
    lines,
    // LABELLED APPROXIMATION — not a provider token count.
    approxTokens: Math.round(chars / 4),
  };
}

function collect() {
  const source = fs.readFileSync(path.join(ROOT, INDEX_REL), 'utf8');
  const prompts = {};
  const missing = [];
  for (const name of PROMPT_CONSTS) {
    const body = extractTemplateConst(source, name);
    if (body === null) {
      missing.push(name);
      continue;
    }
    prompts[name] = measure(body);
  }

  // The composed primary image prompt is what a single camera scan actually
  // pays for: IDENTIFY_PROMPT + the quality addendum. The category-route
  // addendum is added separately and measured on its own below.
  const composedPrimary = (prompts.IDENTIFY_PROMPT?.chars ?? 0) +
    (prompts.QUALITY_TUNE_PROMPT_ADDENDUM?.chars ?? 0);

  return {
    prompts,
    missing,
    composedPrimaryChars: composedPrimary,
    composedPrimaryApproxTokens: Math.round(composedPrimary / 4),
  };
}

function renderTable(current, baseline) {
  const lines = [];
  lines.push('='.repeat(86));
  lines.push('SCANNER PROMPT BUDGET   (chars = exact; approxTokens = chars/4, APPROXIMATION)');
  lines.push('='.repeat(86));
  const header = `${'prompt'.padEnd(32)}${'chars'.padStart(9)}${'~tokens'.padStart(10)}${
    baseline ? `${'Δchars'.padStart(11)}${'Δ~tokens'.padStart(11)}` : ''
  }`;
  lines.push(header);
  lines.push('-'.repeat(86));

  for (const name of PROMPT_CONSTS) {
    const cur = current.prompts[name];
    if (!cur) {
      lines.push(`${name.padEnd(32)}${'MISSING'.padStart(9)}`);
      continue;
    }
    let delta = '';
    if (baseline && baseline.prompts[name]) {
      const dc = cur.chars - baseline.prompts[name].chars;
      const dt = cur.approxTokens - baseline.prompts[name].approxTokens;
      const sign = (n) => (n > 0 ? `+${n}` : String(n));
      delta = `${sign(dc).padStart(11)}${sign(dt).padStart(11)}`;
    }
    lines.push(
      `${name.padEnd(32)}${String(cur.chars).padStart(9)}${String(cur.approxTokens).padStart(10)}${delta}`,
    );
  }

  lines.push('-'.repeat(86));
  let composedDelta = '';
  if (baseline) {
    const dc = current.composedPrimaryChars - baseline.composedPrimaryChars;
    const dt = current.composedPrimaryApproxTokens - baseline.composedPrimaryApproxTokens;
    const sign = (n) => (n > 0 ? `+${n}` : String(n));
    composedDelta = `${sign(dc).padStart(11)}${sign(dt).padStart(11)}`;
  }
  lines.push(
    `${'COMPOSED PRIMARY IMAGE SCAN'.padEnd(32)}${
      String(current.composedPrimaryChars).padStart(9)
    }${String(current.composedPrimaryApproxTokens).padStart(10)}${composedDelta}`,
  );
  lines.push('='.repeat(86));
  lines.push('COMPOSED PRIMARY = IDENTIFY_PROMPT + QUALITY_TUNE_PROMPT_ADDENDUM');
  lines.push('This is the per-scan prompt cost that Phase 7.2 must not materially grow.');
  lines.push('='.repeat(86));
  return lines.join('\n');
}

function main(argv) {
  const asJson = argv.includes('--json');
  const baselineFlag = argv.indexOf('--baseline');
  let baseline = null;
  if (baselineFlag !== -1) {
    const file = argv[baselineFlag + 1];
    if (!file || !fs.existsSync(file)) {
      console.error('[prompt-budget] --baseline requires an existing --json file');
      return 2;
    }
    baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const current = collect();
  if (current.missing.length) {
    console.error(`[prompt-budget] prompt constants not found: ${current.missing.join(', ')}`);
    return 2;
  }

  console.log(asJson ? JSON.stringify(current, null, 2) : renderTable(current, baseline));
  return 0;
}

module.exports = { collect, measure, extractTemplateConst, PROMPT_CONSTS };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
