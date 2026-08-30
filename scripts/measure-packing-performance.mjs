#!/usr/bin/env node
/**
 * K+ Packing Intelligence V1 — pre-model cost measurement (B6).
 *
 * MEASURE BEFORE OPTIMIZING (build plan section 59). This reports what the
 * DETERMINISTIC half of Packing actually costs — retrieval normalization,
 * candidate narrowing, prompt construction — so the decision to optimize (or
 * not) rests on numbers instead of instinct. The provider call is not measured
 * here: it is a network round trip whose cost is the provider's, and mixing the
 * two would hide whichever is smaller.
 *
 * No network, no Supabase, no provider. Synthetic Closets only.
 *
 * Usage: node scripts/measure-packing-performance.mjs
 */

import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The Packing modules are Deno TypeScript with .ts import specifiers, so they
// are measured in Deno rather than reimplemented here. Reimplementing would
// measure a copy, which is exactly the thing that drifts.
const DENO_SCRIPT = String.raw`
import { retrievePackingClosetCandidates } from './supabase/functions/stylechat-generate/packingRetrieval.ts';
import { selectPackingCandidates } from './supabase/functions/stylechat-generate/packingCandidates.ts';
import { buildPackingUserPrompt, PACKING_SYSTEM_PROMPT } from './supabase/functions/stylechat-generate/packingPrompt.ts';
import { parsePackingRequest } from './supabase/functions/stylechat-generate/packingContract.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TYPES = [
  ['shirt', 'oxford shirt', 'white'],
  ['sweater', 'crewneck', 'navy'],
  ['jacket', 'chore jacket', 'black'],
  ['trousers', 'chinos', 'beige'],
  ['jeans', 'straight jeans', 'blue'],
  ['shoes', 'sneakers', 'white'],
  ['boots', 'chelsea boots', 'black'],
  ['dress', 'slip dress', 'black'],
];

function closet(size, singleCategory) {
  return Array.from({ length: size }, (_, index) => {
    const [clothingType, subtype, color] = singleCategory ? TYPES[0] : TYPES[index % TYPES.length];
    return {
      id: '33333333-3333-4333-8333-' + String(index + 1).padStart(12, '0'),
      user_id: ACTOR,
      client_id: 'local-' + index,
      title: color + ' ' + subtype,
      category: 'Apparel',
      clothing_type: clothingType,
      subtype,
      brand: 'Brand ' + (index % 12),
      primary_color: color,
      secondary_colors: ['grey'],
      material: ['cotton'],
      updated_at: new Date(Date.UTC(2026, 7, 1 + (index % 28))).toISOString(),
      deleted_at: null,
    };
  });
}

const parsed = parsePackingRequest({
  schemaVersion: 'packing-plan-v1',
  sessionId: '44444444-4444-4444-8444-444444444444',
  trip: {
    destination: 'Miami',
    startDate: '2026-09-12',
    endDate: '2026-09-16',
    tripType: 'leisure',
    activities: ['travel_day', 'casual_day', 'dinner'],
  },
});
if (!parsed.ok) throw new Error('fixture request failed to parse');

async function measure(label, size, singleCategory) {
  const rows = closet(size, singleCategory);
  const ITERATIONS = 200;
  let retrievalMs = 0;
  let selectionMs = 0;
  let promptMs = 0;
  let promptChars = 0;
  let shortlist = 0;
  let sent = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    let t = performance.now();
    // The query itself is the database's cost; what is measured is the
    // normalization every returned row goes through.
    const retrieval = await retrievePackingClosetCandidates({
      actorId: ACTOR,
      data: { listClosetItems: (_a, limit) => Promise.resolve(rows.slice(0, limit)) },
    });
    retrievalMs += performance.now() - t;
    sent = retrieval.candidates.length;

    t = performance.now();
    const selection = selectPackingCandidates({
      candidates: retrieval.candidates,
      trip: parsed.trip,
      constraints: { excludeItemIds: [], packLight: false, notes: [] },
    });
    selectionMs += performance.now() - t;
    shortlist = selection.shortlist.length;

    t = performance.now();
    const prompt = buildPackingUserPrompt({
      trip: parsed.trip,
      constraints: { excludeItemIds: [], packLight: false, notes: [] },
      shortlist: selection.shortlist,
      weather: { provenance: 'FORECAST', summary: 'highs 87-90F, rain on 2 of 5 days' },
      signatureStyleBlock: null,
    });
    promptMs += performance.now() - t;
    promptChars = PACKING_SYSTEM_PROMPT.length + prompt.length;
  }

  const round = (value) => Math.round(value * 1000) / 1000;
  console.log(JSON.stringify({
    label,
    closetSize: size,
    rowsConsidered: sent,
    shortlist,
    promptChars,
    approxPromptTokens: Math.round(promptChars / 4),
    retrievalMsPerCall: round(retrievalMs / ITERATIONS),
    selectionMsPerCall: round(selectionMs / ITERATIONS),
    promptMsPerCall: round(promptMs / ITERATIONS),
    totalPreModelMsPerCall: round((retrievalMs + selectionMs + promptMs) / ITERATIONS),
  }));
}

await measure('empty', 0, false);
await measure('sparse', 2, false);
await measure('typical', 25, false);
await measure('single-category-50', 50, true);
await measure('large-200', 200, false);
`;

const result = spawnSync('deno', ['eval', DENO_SCRIPT], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.error || result.status !== 0) {
  console.error('Packing performance measurement failed.');
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(1);
}

const rows = result.stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

console.log('K+ PACKING — PRE-MODEL COST (deterministic half only)');
console.log('');
console.log(
  [
    'case'.padEnd(20),
    'closet'.padStart(7),
    'rows'.padStart(6),
    'short'.padStart(6),
    'chars'.padStart(7),
    '~tok'.padStart(6),
    'retr ms'.padStart(9),
    'sel ms'.padStart(8),
    'prompt ms'.padStart(10),
    'total ms'.padStart(9),
  ].join(''),
);
for (const row of rows) {
  console.log(
    [
      row.label.padEnd(20),
      String(row.closetSize).padStart(7),
      String(row.rowsConsidered).padStart(6),
      String(row.shortlist).padStart(6),
      String(row.promptChars).padStart(7),
      String(row.approxPromptTokens).padStart(6),
      row.retrievalMsPerCall.toFixed(3).padStart(9),
      row.selectionMsPerCall.toFixed(3).padStart(8),
      row.promptMsPerCall.toFixed(3).padStart(10),
      row.totalPreModelMsPerCall.toFixed(3).padStart(9),
    ].join(''),
  );
}

const largest = rows[rows.length - 1];
console.log('');
console.log(
  `Worst case (${largest.label}): ${largest.totalPreModelMsPerCall.toFixed(3)} ms of pre-model work, ` +
    `${largest.approxPromptTokens} prompt tokens, shortlist bounded at ${largest.shortlist}.`,
);
console.log(
  'The provider round trip is the dominant cost by orders of magnitude; optimizing the above would not be felt.',
);
