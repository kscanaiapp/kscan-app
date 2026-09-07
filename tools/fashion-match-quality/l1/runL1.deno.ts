// Deno-run L1 harness. Imports the REAL, UNMODIFIED production pure logic
// from supabase/functions/_shared - this is the "reuse it" path spec
// section 22 (L1) requires when production logic is already separable and
// zero-network. Nothing in this file alters, wraps, or monkey-patches the
// imported functions; it only supplies fixture-controlled inputs and
// prints their real outputs as canonical JSON.
//
// Run via: deno run --no-check --allow-read=<inputFile> runL1.deno.ts <inputFile>
// (--no-check skips type-checking the imported Edge Function source for
// speed; this harness does not modify that source, so a type-check failure
// there is a pre-existing repository condition, not something this lab
// introduces or needs to fix.)

import {
  normalizeIdentification,
  rankRecommendedProducts,
} from '../../../supabase/functions/_shared/scanHelpers.ts';
import {
  adaptCatalogCandidate,
  mergeProductCandidates,
} from '../../../supabase/functions/_shared/catalogRetrieval.ts';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function main() {
  const inputPath = Deno.args[0];
  if (!inputPath) {
    console.error('usage: runL1.deno.ts <inputJsonFile>');
    Deno.exit(2);
  }

  const raw = await Deno.readTextFile(inputPath);
  const input = JSON.parse(raw) as {
    garmentIdentification: Record<string, unknown>;
    candidateProducts: Record<string, unknown>[];
  };

  const normalized = normalizeIdentification(input.garmentIdentification as never);

  // Run the real candidate-normalization + first-pass dedup exactly as
  // production does (catalog-shaped candidates through adaptCatalogCandidate,
  // then merged with mergeProductCandidates - see catalogRetrieval.ts).
  const adapted = (input.candidateProducts || []).map((c) => adaptCatalogCandidate(c as never));
  const merged = mergeProductCandidates([], adapted as never[]);

  const ranked = rankRecommendedProducts(merged as unknown[], normalized);

  const output = {
    normalized,
    mergedCandidateCount: merged.length,
    ranked,
  };

  console.log(JSON.stringify(sortKeysDeep(output)));
}

main();
