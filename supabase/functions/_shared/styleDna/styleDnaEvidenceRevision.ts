// Build 34 / Track B / Phase B4 — Style DNA evidence revision (Micro-addendum E).
//
// PURE MODULE. No Deno/network imports.
//
// A naive item COUNT is not sufficient freshness evidence: two Closets can
// share a count but differ entirely in content (an edit that changes color,
// brand, or category on an existing row never changes the count). The V1
// fallback revision is the smallest deterministic representation that still
// distinguishes "the same relevant evidence" from "changed relevant evidence"
// for the common cases this phase needs to handle correctly:
//
//   {MAX(updated_at) of non-tombstoned rows}:{COUNT(non-tombstoned rows)}
//
// A row's own `updated_at` already advances on every authoritative facts or
// media write (B1A's own update-authority trigger), and a deletion changes
// the live-row count. Together these catch every practical evidence change
// this phase needs to catch, without event sourcing, a Merkle tree, or a new
// revision service.

export const STYLE_DNA_EMPTY_EVIDENCE_REVISION = 'empty:0';

/**
 * Compute the V1 evidence revision from the current non-tombstoned Closet
 * rows' `updated_at` timestamps.
 *
 * `updatedAtValues` must already be filtered to the current user's
 * non-tombstoned rows — this function has no notion of ownership or
 * tombstoning; it is a pure reduction over whatever timestamps it is given.
 */
export function computeClosetEvidenceRevision(updatedAtValues: readonly string[]): string {
  const values = Array.isArray(updatedAtValues) ? updatedAtValues.filter((v) => typeof v === 'string' && v) : [];
  if (values.length === 0) return STYLE_DNA_EMPTY_EVIDENCE_REVISION;

  let maxIso = values[0];
  let maxMs = Date.parse(maxIso);
  for (const value of values) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (!Number.isFinite(maxMs) || ms > maxMs)) {
      maxMs = ms;
      maxIso = value;
    }
  }
  return `${maxIso}:${values.length}`;
}
