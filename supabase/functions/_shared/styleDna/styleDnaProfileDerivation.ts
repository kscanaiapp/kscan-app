// Build 34 / Track B / Phase B4 — deterministic Style DNA derivation.
//
// PURE MODULE. No Deno/network imports, no LLM call. Structured Closet facts
// in, a bounded aggregate summary out — the same input always produces the
// same output (Micro-addendum J/K: "same evidence -> same profile").
//
// WHY NO LLM HERE (section 30): reproducible, explainable, cheap, testable,
// stable, and never hallucinates a trait the evidence does not support. An
// LLM may later INTERPRET this profile (e.g. inside Elise's prompt); it never
// generates the underlying facts.
//
// EVERY OUTPUT SIGNAL IS TRACEABLE TO SOURCE FACTS (section 29). This module
// only counts values that are already present on Closet rows — it never
// infers a psychological trait, a taste judgment, or anything the facts do
// not directly state.

import {
  STYLE_DNA_TOP_N,
  type StyleDnaClosetFactsRow,
  type StyleDnaFrequencyEntry,
  type StyleDnaProfileDataV1,
} from './styleDnaProfileTypes.ts';

/** Normalizes a free-text facts value into a stable, case-insensitive bucket
 *  key while keeping a presentable original casing for the first occurrence
 *  seen. Trims, and rejects empty/whitespace-only values (never counted). */
function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

class FrequencyCounter {
  private counts = new Map<string, number>();
  private display = new Map<string, string>();

  add(rawValue: string | null | undefined): void {
    const value = normalize(rawValue);
    if (!value) return;
    const key = value.toLowerCase();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (!this.display.has(key)) this.display.set(key, value);
  }

  /** Highest-frequency first; a stable alphabetical tie-break on the display
   *  value keeps output deterministic when two values tie exactly. */
  topN(limit: number): StyleDnaFrequencyEntry[] {
    return [...this.counts.entries()]
      .map(([key, count]) => ({ value: this.display.get(key) as string, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, Math.max(0, limit));
  }
}

/**
 * Derive the bounded Style DNA aggregate from a user's own non-tombstoned
 * Closet facts rows.
 *
 * `rows` must already be scoped to exactly one user's non-tombstoned
 * evidence — this function has no notion of ownership or tombstoning.
 *
 * An empty Closet produces a valid, empty profile (all frequency arrays
 * empty, evidenceCount 0) — never a fabricated preference (section E of the
 * addendum: "Empty Closet: valid empty profile. Do not fabricate preferences").
 */
export function deriveStyleDnaProfile(rows: readonly StyleDnaClosetFactsRow[]): StyleDnaProfileDataV1 {
  const safeRows = Array.isArray(rows) ? rows : [];

  const colors = new FrequencyCounter();
  const categories = new FrequencyCounter();
  const garmentTypes = new FrequencyCounter();
  const brands = new FrequencyCounter();
  const materials = new FrequencyCounter();

  for (const row of safeRows) {
    if (!row) continue;
    colors.add(row.primaryColor);
    if (Array.isArray(row.secondaryColors)) {
      for (const color of row.secondaryColors) colors.add(color);
    }
    categories.add(row.category);
    garmentTypes.add(row.clothingType);
    brands.add(row.brand);
    if (Array.isArray(row.material)) {
      for (const m of row.material) materials.add(m);
    }
  }

  return {
    evidenceCount: safeRows.length,
    colorFrequency: colors.topN(STYLE_DNA_TOP_N),
    categoryFrequency: categories.topN(STYLE_DNA_TOP_N),
    garmentTypeFrequency: garmentTypes.topN(STYLE_DNA_TOP_N),
    brandFrequency: brands.topN(STYLE_DNA_TOP_N),
    materialFrequency: materials.topN(STYLE_DNA_TOP_N),
  };
}
