/**
 * Sanitizer for client-supplied Closet / Recent Scans comparison candidates.
 *
 * WHY THE CLIENT SUPPLIES THESE
 *
 * The obvious alternative — have the backend query the user's closet — was
 * rejected. It would give `scan-identify` a user-scoped read it does not
 * currently have, put closet contents inside a function that also talks to
 * third-party providers, and make the similarity logic untestable without a
 * database. The client already holds both lists in memory to render them.
 *
 * WHAT THIS ENFORCES
 *
 * A strict allowlist, because these values are forwarded to another service. An
 * unbounded passthrough here would let a future client field — a user id, a
 * signed URL, an image payload — reach product-match without anyone deciding it
 * should. Unknown fields are DROPPED rather than rejected: a scan must not fail
 * because a newer client sent an extra field, and this is a comparison
 * convenience rather than the scan's purpose.
 *
 * `imageUri` is allowed and is the one field worth justifying. It is a
 * reference the client already holds and will render locally; it is echoed back
 * for side-by-side display and is never fetched, never read, and never sent to
 * a provider.
 */

/** Cap on candidates accepted per request. */
export const MAX_EXISTING_ITEMS = 25;

const ALLOWED_FIELDS = [
  'id', 'source', 'label', 'imageUri', 'brand', 'model',
  'canonicalCategory', 'color', 'material', 'silhouette', 'pattern', 'productUrl',
] as const;

const LENGTH_LIMITS: Record<string, number> = {
  id: 128,
  source: 24,
  label: 160,
  imageUri: 2048,
  brand: 80,
  model: 120,
  canonicalCategory: 60,
  color: 60,
  material: 60,
  silhouette: 60,
  pattern: 60,
  productUrl: 2048,
};

function clean(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped ? stripped.slice(0, maxLength) : null;
}

export type SanitizedExistingItem = {
  id: string;
  source: 'closet' | 'recent_scan';
  [field: string]: unknown;
};

/**
 * Returns the candidates worth forwarding, dropping anything malformed.
 *
 * Silent dropping is correct here specifically because the feature is
 * advisory: a candidate that cannot be compared simply is not compared, and
 * the user still gets their scan. The count that survived is reported in the
 * `scanJourney.similarity` seam, so a client sending 20 candidates and seeing
 * `candidatesAvailable: 3` can tell that something is wrong with what it sent.
 */
export function sanitizeExistingItemCandidates(raw: unknown): SanitizedExistingItem[] {
  if (!Array.isArray(raw)) return [];

  const out: SanitizedExistingItem[] = [];
  const seenIds = new Set<string>();

  for (const entry of raw) {
    if (out.length >= MAX_EXISTING_ITEMS) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const id = clean(record.id, LENGTH_LIMITS.id);
    const source = clean(record.source, LENGTH_LIMITS.source);
    if (!id) continue;
    if (source !== 'closet' && source !== 'recent_scan') continue;
    // A repeated id would produce two comparisons against the same item, which
    // reads to the user as the system being unsure rather than thorough.
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const sanitized: SanitizedExistingItem = { id, source };
    for (const field of ALLOWED_FIELDS) {
      if (field === 'id' || field === 'source') continue;
      const value = clean(record[field], LENGTH_LIMITS[field]);
      if (value) sanitized[field] = value;
    }
    out.push(sanitized);
  }

  return out;
}
