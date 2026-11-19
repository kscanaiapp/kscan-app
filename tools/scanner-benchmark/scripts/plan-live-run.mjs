#!/usr/bin/env node
// Live Staging run planner. PRINTS A PLAN; EXECUTES NOTHING.
//
//   node plan-live-run.mjs [--manifest <path>] [--split development|holdout|all]
//                          [--actors N] [--max-garments-per-case 3]
//                          [--gemini-input-per-mtok X --gemini-output-per-mtok Y]
//                          [--serper-per-call Z]
//
// Request model per case (mirrors the shipped multi-item Scanner flow):
//   non_fashion       1 detection
//   otherwise         1 detection + k selected-item + k commerce_only,
//                     k = min(labelled garments, max-garments-per-case) (1 for single-item cases)
// Quota (scan-identify durable buckets, per actor per UTC day): image 30, commerce_only 60.
// Prices are inputs. No default price is assumed; omitted prices leave cost unprojected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const manifest = JSON.parse(fs.readFileSync(opt('--manifest', path.join(here, '..', 'manifest', 'cases.v1.json')), 'utf8'));
const split = opt('--split', 'development');
const actors = Number(opt('--actors', '1'));
const maxG = Number(opt('--max-garments-per-case', '3'));
const price = {
  inMTok: opt('--gemini-input-per-mtok') ? Number(opt('--gemini-input-per-mtok')) : null,
  outMTok: opt('--gemini-output-per-mtok') ? Number(opt('--gemini-output-per-mtok')) : null,
  serper: opt('--serper-per-call') ? Number(opt('--serper-per-call')) : null,
};
const IMAGE_QUOTA = 30, COMMERCE_QUOTA = 60;
// Token envelope per image call: image tiles (~4 x 258 at 896 px width) + prompt text, and the
// output cap. These bound cost from above; measured usage replaces them after the run.
const TOKENS = { inputPerImageCall: 1032 + 3000, outputCapPerImageCall: 2048 };

const cases = manifest.cases.filter((c) => split === 'all' || c.split === split);
let detection = 0, selected = 0, commerce = 0;
for (const c of cases) {
  detection++;
  if (c.labels.nonFashion) continue;
  const k = Math.min(Math.max(1, c.labels.garments?.length ?? 1), maxG);
  selected += k; commerce += k;
}
const imageCalls = detection + selected;
const plan = {
  split, cases: cases.length, actors,
  requests: { detection, selectedItem: selected, commerceOnly: commerce, imageModeTotal: imageCalls },
  quotaDays: { image: Math.ceil(imageCalls / (IMAGE_QUOTA * actors)), commerceOnly: Math.ceil(commerce / (COMMERCE_QUOTA * actors)) },
  geminiTokenEnvelope: { inputUpperBound: imageCalls * TOKENS.inputPerImageCall, outputUpperBound: imageCalls * TOKENS.outputCapPerImageCall, note: 'upper bound; Gemini retries (max 2 attempts per call) can double it' },
  costUpperBoundUsd: price.inMTok !== null && price.outMTok !== null
    ? {
      gemini: 2 * ((imageCalls * TOKENS.inputPerImageCall) / 1e6 * price.inMTok + (imageCalls * TOKENS.outputCapPerImageCall) / 1e6 * price.outMTok),
      serper: price.serper !== null ? commerce * 3 * price.serper : null,
      note: 'gemini x2 for the retry ceiling; serper x3 for primary + fallback + VRI-03 H3 query ceiling',
    }
    : null,
  executes: false,
};
console.log(JSON.stringify(plan, null, 2));
