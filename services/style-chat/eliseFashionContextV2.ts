// Elise canonical fashion context (Phase 2B.3).
//
// THE ONE DOWNSTREAM CONTRACT. Every Elise attachment source — a freshly
// identified camera/gallery image, an aggregated header-gallery selection, a
// reused Scanner V2 result, a reused V2 Recent Scan — becomes one
// `EliseFashionContextV2` here, and `stylechat-generate` receives it through the
// single additive `fashionContextV2` request field. There is no
// platform-specific identity field.
//
// WHAT THIS MODULE GUARANTEES:
//   - the canonical result is validated on its own terms, then PROJECTED onto a
//     styling-safe identity; the canonical object itself is never mutated and
//     stays valid for every other holder
//   - the object is JSON-serializable and round-trips identically, so no
//     function, ref, setter or AbortController can ride along
//   - no Base64, evidence id, candidate id, detection digest, bounds, local URI,
//     provider response, retailer URL or purchase option can be present
//   - items stay separate and in source order; two grey jackets are two items
//   - a partial identity stays useful instead of collapsing to a failure

import {
  ELISE_FASHION_CONTEXT_SOURCES,
  ELISE_FASHION_CONTEXT_V2,
  ELISE_FASHION_IDENTITY_V2,
  ELISE_FASHION_ITEM_STATES,
  FASHION_IDENTIFICATION_RESOLUTION_LEVELS,
  FASHION_IDENTIFICATION_STATUSES,
  type EliseFashionContextItemV2,
  type EliseFashionContextSource,
  type EliseFashionContextV2,
  type EliseFashionIdentityV2,
  type EliseFashionItemState,
  type FashionIdentificationResultV2,
} from '../../types/fashionIdentificationV2';
import { isRecord, str, validateFashionV2Response } from '../fashionIdentificationV2Core';

/**
 * Keys that must never appear anywhere inside a canonical context.
 *
 * Checked structurally on the finished object rather than trusted to have been
 * omitted at construction: the context is assembled from several sources, and a
 * future caller spreading a wider object in is the realistic way one of these
 * would arrive.
 */
const FORBIDDEN_CONTEXT_KEYS = new Set([
  'imagebase64',
  'base64',
  'evidenceid',
  // Plural form: the canonical contract nests `conflicts[].evidenceIds`, and a
  // key scan that only knows the singular accepts exactly that nesting.
  'evidenceids',
  'requestid',
  'candidateid',
  'detectiondigest',
  'bounds',
  'imageuri',
  'localimageuri',
  'sanitizedimageuri',
  'sanitizedpreviewuri',
  'previewuri',
  'rawimageuri',
  'uri',
  'assetid',
  'filename',
  'providerresponse',
  'purchase_options',
  'purchaseoptions',
  'recommendedproducts',
  'similaritymatches',
  'retailerurl',
  'retailername',
  'producturl',
  'affiliateurl',
  'imageurl',
  'purchaseurl',
  'price',
  'sku',
  'userid',
  'deviceid',
  'actorkey',
]);

const RAW_IMAGE_REFERENCE = /(?:file|content|ph|asset-library):\/\/|data:image\/|;base64,/i;

/**
 * Commerce content inside an allowed STRING field.
 *
 * The key allowlist stops a `purchaseOptions` array from being attached. It does
 * nothing about a retailer URL or a price written into a field that is legitimately
 * copied — `unknownReason`, or a `conflicts[].description`. Those are free text
 * derived from provider output, and §23 forbids retailer URLs and commerce data in
 * the context regardless of which field carries them.
 *
 * A garment attribute never contains a URL or a currency amount, so refusing them
 * costs no real value.
 */
const COMMERCE_CONTENT =
  /https?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}|[$£€]\s?\d|\b\d+(?:\.\d{2})?\s?(?:USD|EUR|GBP)\b/i;

/**
 * Exact key allowlists, mirroring what `stylechat-generate` enforces.
 *
 * WHY AN ALLOWLIST AND NOT ONLY A DENYLIST: a denylist stops the leaks we thought
 * of. The backend already refuses unknown keys, so a client that attaches one
 * builds a body the backend will reject — failing here instead turns a remote
 * rejection into a local, testable one, and closes the whole class rather than
 * the named members of it.
 */
const CONTEXT_KEYS: ReadonlySet<string> = new Set(['contractVersion', 'source', 'items']);
const CONFLICT_ENTRY_KEYS: ReadonlySet<string> = new Set(['field', 'description']);
const ITEM_KEYS: ReadonlySet<string> = new Set(['sourceIndex', 'state', 'identification']);
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'identityVersion', 'status', 'resolutionLevel', 'category', 'subtype', 'brand',
  'colors', 'material', 'silhouette', 'pattern', 'attributes', 'confidence',
  'exactProduct', 'conflicts', 'unknownReason', 'globalConfidence',
]);

function unknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

// ── Construction ─────────────────────────────────────────────────────────────

export type EliseFashionContextItemInput = {
  sourceIndex: number;
  state: EliseFashionItemState;
  identification?: FashionIdentificationResultV2 | null;
};

/** Trimmed non-empty string, or null. */
function nz(value: unknown): string | null {
  return str(value);
}

/** Deduplicated list of trimmed non-empty strings. */
function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = str(entry);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Clamped confidence, or null. NEVER coerced to 0 — absent is not zero. */
function conf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

const BRAND_PROVENANCES = new Set([
  'visual', 'visible_text', 'logo_shape', 'catalog_corroboration',
  'commerce_corroboration', 'unknown',
]);

/**
 * Projects a VALIDATED canonical result onto the styling-safe identity.
 *
 * A COPY of the styling-relevant fields — never a mutated canonical object. The
 * input is left completely untouched and remains a valid
 * `FashionIdentificationResultV2` for whoever else holds it.
 *
 * What is deliberately NOT copied, and why:
 *   requestId                    per-request bookkeeping
 *   evidence[]                   carries evidenceId
 *   candidates[]                 carries evidenceId and bounds
 *   brand.evidence[]             carries evidenceId — the nested case an
 *                                incomplete strip would miss
 *   conflicts[].evidenceIds      carries evidenceId
 *   exactProduct.sku             a stock keeping unit is commerce, not styling
 *   compatibility.*              legacy-projection and commerce-skip bookkeeping
 *
 * Returns null when the result carries neither a category nor a subtype: with
 * neither there is nothing to ground styling on, and an item with no identity must
 * not enter the context as though it had one.
 */
export function projectCanonicalToEliseIdentity(
  result: FashionIdentificationResultV2,
): EliseFashionIdentityV2 | null {
  if (!isRecord(result) || !isRecord(result.item)) return null;
  const item = result.item;
  const category = nz(item.category);
  const subtype = nz(item.subtype);
  if (!category && !subtype) return null;

  const empty: Record<string, unknown> = {};
  const brand = isRecord(item.brand) ? item.brand : empty;
  const colors = isRecord(item.colors) ? item.colors : empty;
  const attributes = isRecord(item.attributes) ? item.attributes : empty;
  const confidence = isRecord(result.confidence) ? result.confidence : empty;
  const compatibility = isRecord(result.compatibility) ? result.compatibility : empty;
  const provenance = nz(brand.provenance);

  const exactProductRaw = result.exactProduct;
  const exactProduct = String(result.resolutionLevel) === 'exact_product' && isRecord(exactProductRaw)
    ? { brand: nz(exactProductRaw.brand), model: nz(exactProductRaw.model) }
    : null;

  const conflicts: Array<{ field: string; description: string }> = [];
  if (Array.isArray(result.conflicts)) {
    for (const entry of result.conflicts) {
      if (!isRecord(entry)) continue;
      const field = nz(entry.field);
      const description = nz(entry.description);
      if (field && description) conflicts.push({ field, description });
    }
  }

  return {
    identityVersion: ELISE_FASHION_IDENTITY_V2,
    status: result.status,
    resolutionLevel: result.resolutionLevel,
    category,
    subtype,
    brand: {
      value: nz(brand.value),
      confidence: conf(brand.confidence),
      provenance: (provenance && BRAND_PROVENANCES.has(provenance)
        ? provenance
        : 'unknown') as EliseFashionIdentityV2['brand']['provenance'],
    },
    colors: { primary: nz(colors.primary), secondary: list(colors.secondary) },
    material: list(item.material),
    silhouette: list(item.silhouette),
    pattern: list(item.pattern),
    attributes: {
      fit: nz(attributes.fit),
      length: nz(attributes.length),
      sleeve: nz(attributes.sleeve),
      neckline: nz(attributes.neckline),
      collar: nz(attributes.collar),
      closure: nz(attributes.closure),
      pockets: list(attributes.pockets),
      visible: list(attributes.visible),
      distinctive: list(attributes.distinctive),
    },
    confidence: {
      category: conf(confidence.category),
      subtype: conf(confidence.subtype),
      brand: conf(confidence.brand),
      modelFamily: conf(confidence.modelFamily),
      exactProduct: conf(confidence.exactProduct),
    },
    exactProduct,
    conflicts,
    unknownReason: nz(result.unknownReason),
    globalConfidence: conf(compatibility.globalConfidence),
  };
}

/**
 * Builds the canonical context from per-source outcomes.
 *
 * Items are sorted by `sourceIndex`, never by completion order: asynchronous
 * results arrive in whatever order the network settles them, and letting that
 * order become the item order is how "the third photo" silently becomes "the
 * first item".
 *
 * A `ready`/`partial` item whose identification does not validate is DOWNGRADED
 * to `technical_failure` rather than dropped. Dropping it would renumber nothing
 * but would also make the user's third attachment vanish with no retry
 * affordance; downgrading keeps the slot and its remove/retry state honest.
 */
export function buildEliseFashionContextV2(input: {
  source: EliseFashionContextSource;
  items: EliseFashionContextItemInput[];
}): EliseFashionContextV2 | null {
  if (!input || !(ELISE_FASHION_CONTEXT_SOURCES as readonly string[]).includes(input.source)) {
    return null;
  }
  if (!Array.isArray(input.items) || input.items.length === 0) return null;

  const items: EliseFashionContextItemV2[] = [];
  for (const entry of input.items) {
    if (!isRecord(entry)) return null;
    if (!Number.isSafeInteger(entry.sourceIndex) || entry.sourceIndex < 0) return null;
    if (!(ELISE_FASHION_ITEM_STATES as readonly string[]).includes(entry.state)) return null;

    const wantsIdentity = entry.state === 'ready' || entry.state === 'partial';
    if (!wantsIdentity) {
      // A non-evidence state carries no identification at all. Attaching one
      // would let a failed image be read as grounded styling evidence.
      items.push({ sourceIndex: entry.sourceIndex, state: entry.state });
      continue;
    }

    // The canonical result is validated on ITS OWN terms first, then projected.
    // Validating the canonical contract and validating the projection are two
    // separate checks on two separate shapes — neither stands in for the other.
    const validated = validateFashionV2Response(entry.identification);
    if (validated.kind !== 'ok') {
      items.push({ sourceIndex: entry.sourceIndex, state: 'technical_failure' });
      continue;
    }
    const projected = projectCanonicalToEliseIdentity(validated.result);
    if (!projected) {
      // Valid contract, but no category and no subtype: nothing to ground on.
      items.push({ sourceIndex: entry.sourceIndex, state: 'insufficient_evidence' });
      continue;
    }
    items.push({
      sourceIndex: entry.sourceIndex,
      state: entry.state,
      identification: projected,
    });
  }

  // Duplicate source indices would make two items indistinguishable to any
  // consumer that keys on them, including the retry/remove UI.
  if (new Set(items.map((item) => item.sourceIndex)).size !== items.length) return null;
  items.sort((left, right) => left.sourceIndex - right.sourceIndex);

  return { contractVersion: ELISE_FASHION_CONTEXT_V2, source: input.source, items };
}

/** Items that may ground the model: a validated `ready` or `partial` identity. */
export function groundableItems(context: EliseFashionContextV2 | null): EliseFashionContextItemV2[] {
  if (!context || !Array.isArray(context.items)) return [];
  return context.items.filter(
    (item) => (item.state === 'ready' || item.state === 'partial') && Boolean(item.identification),
  );
}

/**
 * True when the context carries at least one groundable item.
 *
 * A context of nothing but failures is NOT sendable as visual grounding, and
 * sending it would be the placeholder-context defect in a new costume.
 */
export function hasGroundableEvidence(context: EliseFashionContextV2 | null): boolean {
  return groundableItems(context).length > 0;
}

// ── Serialization safety ─────────────────────────────────────────────────────

/**
 * Walks the finished object looking for anything that must not cross the wire.
 *
 * Returns a bounded path string, never the offending value: this runs on data
 * derived from provider output, so echoing the value would put provider output
 * into whatever logs the caller writes.
 */
export function findForbiddenContextPath(value: unknown, path = '$'): string | null {
  if (value === null || value === undefined) return null;
  const valueType = typeof value;
  if (valueType === 'function') return `${path}:function`;
  if (valueType === 'symbol') return `${path}:symbol`;
  if (valueType === 'bigint') return `${path}:bigint`;
  if (valueType === 'string') {
    if (RAW_IMAGE_REFERENCE.test(value as string)) return `${path}:raw_image_reference`;
    // A retailer URL or a price in a descriptive field is commerce data, whatever
    // field it arrived in.
    if (COMMERCE_CONTENT.test(value as string)) return `${path}:commerce_content`;
    return null;
  }
  if (valueType !== 'object') return null;
  if (value instanceof Map) return `${path}:map`;
  if (value instanceof Set) return `${path}:set`;
  if (value instanceof Date) return `${path}:date`;
  if (value instanceof Error) return `${path}:error`;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenContextPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTEXT_KEYS.has(key.toLowerCase())) return `${path}.${key}:forbidden_key`;
    const found = findForbiddenContextPath(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export type ContextTransportCheck =
  | { kind: 'ok'; context: EliseFashionContextV2 }
  | { kind: 'invalid'; reason: string };

/**
 * The pre-transport gate: structural validity, forbidden-content scan, and a
 * real JSON round trip.
 *
 * The round trip is not ceremony. `JSON.stringify` silently drops `undefined`
 * values and functions, so an object can satisfy every in-memory check and still
 * arrive at the backend missing a required field. Validating the round-tripped
 * value is the only way to assert that what the backend receives is what was
 * checked.
 */
export function prepareContextForTransport(context: unknown): ContextTransportCheck {
  const validated = validateEliseFashionContextV2(context);
  if (validated.kind !== 'ok') return validated;

  const forbidden = findForbiddenContextPath(validated.context);
  if (forbidden) return { kind: 'invalid', reason: `forbidden_content:${forbidden}` };

  let roundTripped: unknown;
  try {
    roundTripped = JSON.parse(JSON.stringify(validated.context));
  } catch {
    return { kind: 'invalid', reason: 'not_serializable' };
  }
  const revalidated = validateEliseFashionContextV2(roundTripped);
  if (revalidated.kind !== 'ok') {
    return { kind: 'invalid', reason: `round_trip:${revalidated.reason}` };
  }
  return { kind: 'ok', context: revalidated.context };
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ContextValidation =
  | { kind: 'ok'; context: EliseFashionContextV2 }
  | { kind: 'invalid'; reason: string };

/**
 * Runtime validation of a canonical context.
 *
 * A TypeScript type is not a runtime guarantee, and this object is assembled
 * from several sources including one (the persisted snapshot) that was written
 * by an older build. Bounded reasons only.
 */
export function validateEliseFashionContextV2(value: unknown): ContextValidation {
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not_an_object' };
  if (value.contractVersion !== ELISE_FASHION_CONTEXT_V2) {
    return { kind: 'invalid', reason: 'contract_version' };
  }
  if (!(ELISE_FASHION_CONTEXT_SOURCES as readonly string[]).includes(String(value.source))) {
    return { kind: 'invalid', reason: 'source' };
  }
  const strayContextKey = unknownKey(value, CONTEXT_KEYS);
  if (strayContextKey) return { kind: 'invalid', reason: `unknown_key:${strayContextKey}` };
  if (!Array.isArray(value.items) || value.items.length === 0) {
    return { kind: 'invalid', reason: 'items' };
  }

  const seen = new Set<number>();
  for (const item of value.items) {
    if (!isRecord(item)) return { kind: 'invalid', reason: 'item_shape' };
    const strayItemKey = unknownKey(item, ITEM_KEYS);
    if (strayItemKey) return { kind: 'invalid', reason: `unknown_item_key:${strayItemKey}` };
    if (!Number.isSafeInteger(item.sourceIndex) || (item.sourceIndex as number) < 0) {
      return { kind: 'invalid', reason: 'item_source_index' };
    }
    if (seen.has(item.sourceIndex as number)) {
      return { kind: 'invalid', reason: 'duplicate_source_index' };
    }
    seen.add(item.sourceIndex as number);
    if (!(ELISE_FASHION_ITEM_STATES as readonly string[]).includes(String(item.state))) {
      return { kind: 'invalid', reason: 'item_state' };
    }
    const wantsIdentity = item.state === 'ready' || item.state === 'partial';
    if (wantsIdentity) {
      // Validates the PROJECTION's own shape. Deliberately NOT
      // `validateFashionV2Response`: that checks the canonical contract, which
      // this object is not and does not claim to be.
      const reason = validateEliseIdentity(item.identification);
      if (reason) return { kind: 'invalid', reason: `item_identification:${reason}` };
    } else if (item.identification !== undefined) {
      // A failure state carrying an identity is contradictory: something would
      // then be able to read it as evidence.
      return { kind: 'invalid', reason: 'unexpected_identification' };
    }
  }

  return { kind: 'ok', context: value as unknown as EliseFashionContextV2 };
}

/**
 * Structural validation of a styling-safe identity.
 *
 * Returns a bounded reason string, or null when valid. Bounded because this runs
 * on data derived from provider output, and echoing the offending value would put
 * provider output into whatever log the caller writes.
 *
 * The forbidden-correlation check is NOT repeated here — `findForbiddenContextPath`
 * scans the whole finished context for that. This is purely "is this the shape it
 * claims to be".
 */
export function validateEliseIdentity(value: unknown): string | null {
  if (!isRecord(value)) return 'not_an_object';
  if (value.identityVersion !== ELISE_FASHION_IDENTITY_V2) return 'identity_version';
  const strayKey = unknownKey(value, IDENTITY_KEYS);
  if (strayKey) return `unknown_key_${strayKey}`;
  if (!(FASHION_IDENTIFICATION_STATUSES as readonly string[]).includes(String(value.status))) {
    return 'status';
  }
  if (
    !(FASHION_IDENTIFICATION_RESOLUTION_LEVELS as readonly string[])
      .includes(String(value.resolutionLevel))
  ) {
    return 'resolution_level';
  }
  // At least one of category / subtype must be a real value: an identity with
  // neither cannot ground styling and must not be presented as though it could.
  if (!nz(value.category) && !nz(value.subtype)) return 'no_identity';

  const brand = value.brand;
  if (!isRecord(brand)) return 'brand';
  if (!BRAND_PROVENANCES.has(String(brand.provenance))) return 'brand_provenance';
  if (brand.value !== null && typeof brand.value !== 'string') return 'brand_value';
  if (brand.confidence !== null && typeof brand.confidence !== 'number') return 'brand_confidence';

  const colors = value.colors;
  if (!isRecord(colors) || !Array.isArray(colors.secondary)) return 'colors';
  if (colors.primary !== null && typeof colors.primary !== 'string') return 'colors_primary';

  for (const key of ['material', 'silhouette', 'pattern', 'conflicts']) {
    if (!Array.isArray(value[key])) return key;
  }

  // Conflict entries are the one nested shape the canonical contract decorates
  // with transport correlation (`evidenceIds`). The projection rebuilds them as
  // exactly {field, description}; anything wider is a canonical leak.
  for (const entry of value.conflicts as unknown[]) {
    if (!isRecord(entry)) return 'conflict_entry';
    const strayConflictKey = unknownKey(entry, CONFLICT_ENTRY_KEYS);
    if (strayConflictKey) return `conflict_key_${strayConflictKey}`;
    if (typeof entry.field !== 'string' || typeof entry.description !== 'string') {
      return 'conflict_entry';
    }
  }

  const attributes = value.attributes;
  if (!isRecord(attributes)) return 'attributes';
  for (const key of ['pockets', 'visible', 'distinctive']) {
    if (!Array.isArray(attributes[key])) return `attributes_${key}`;
  }

  const confidence = value.confidence;
  if (!isRecord(confidence)) return 'confidence';
  for (const key of ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct']) {
    // The key must EXIST and be null-or-number. A missing key is what
    // `undefined` + JSON.stringify silently produces, and an absent confidence is
    // not the same claim as a zero one.
    if (!Object.prototype.hasOwnProperty.call(confidence, key)) {
      return `confidence_missing_${key}`;
    }
    const entry = confidence[key];
    if (entry !== null && typeof entry !== 'number') return `confidence_type_${key}`;
  }

  if (value.exactProduct !== null && !isRecord(value.exactProduct)) return 'exact_product';
  // A SKU is commerce metadata and must never have been copied across.
  if (isRecord(value.exactProduct) && 'sku' in value.exactProduct) return 'exact_product_sku';
  if (value.globalConfidence !== null && typeof value.globalConfidence !== 'number') {
    return 'global_confidence';
  }
  return null;
}

// ── Null-safe display projection ─────────────────────────────────────────────

function nonEmptyParts(values: Array<unknown>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = str(value);
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * A human-readable description built ONLY from validated non-empty values.
 *
 * Never template-interpolates a nullable field. `${identity.brand?.value} ${x}` is
 * the shape that renders "undefined Jacket" and "null jacket", and no amount of
 * optional chaining prevents it — the fix is to filter before joining, not to
 * chain before interpolating.
 *
 * Returns '' when nothing is known. Callers must treat '' as "no label", not as
 * a label.
 */
export function describeIdentification(
  identity: EliseFashionIdentityV2 | null | undefined,
): string {
  if (!isRecord(identity)) return '';
  const colors = isRecord(identity.colors) ? identity.colors : null;
  const brand = isRecord(identity.brand) ? identity.brand : null;
  const brandValue = brand ? str(brand.value) : null;
  const subtype = str(identity.subtype);

  const parts = nonEmptyParts([
    colors?.primary,
    subtype,
    // Category is only added when it is not already carried by the subtype, so a
    // "Chore Jacket" does not render as "Chore Jacket Outerwear".
    subtype ? null : identity.category,
  ]);
  const described = parts.join(' ');
  if (!described) {
    // Brand alone is still real, useful evidence — better than "".
    return brandValue ? brandValue : '';
  }
  return brandValue ? `${described} from ${brandValue}` : described;
}

/**
 * A short, honest title for one item.
 *
 * Falls back through subtype → category → brand → a neutral literal. The neutral
 * literal is a UI label, not a claim about the garment, which is why it is not
 * 'Fashion item' or a guessed category.
 */
export function titleForItem(item: EliseFashionContextItemV2 | null | undefined): string {
  const identity = item?.identification;
  if (!isRecord(identity)) return 'Photo';
  const brand = isRecord(identity.brand) ? identity.brand : null;
  return str(identity.subtype) ?? str(identity.category) ?? (brand ? str(brand.value) : null) ?? 'Photo';
}

/**
 * Primary colour from a styling-safe identity, or '' when none was observed.
 *
 * Returns a plain empty string rather than a placeholder because the callers put
 * this into a free-text field: an empty field reads as "not detected, add it if
 * you like", whereas "Unknown" would be saved verbatim as the garment's colour.
 */
export function primaryColorOf(
  identity: EliseFashionIdentityV2 | null | undefined,
): string {
  if (!isRecord(identity) || !isRecord(identity.colors)) return '';
  return str(identity.colors.primary) ?? '';
}

/**
 * A short honest summary line from a styling-safe identity.
 *
 * Composed by FILTERING then joining — never by interpolating nullables. A
 * `partial` status says so explicitly, so a half-identified garment is never
 * described with the same certainty as a fully identified one.
 *
 * Returns '' when nothing is known; callers must treat '' as "no summary".
 */
export function summaryOf(
  identity: EliseFashionIdentityV2 | null | undefined,
): string {
  if (!isRecord(identity)) return '';
  const brand = isRecord(identity.brand) ? str(identity.brand.value) : null;
  const descriptor = nonEmptyParts([
    primaryColorOf(identity) || null,
    str(identity.subtype) ?? identity.category,
  ]).join(' ');
  if (!descriptor) return brand ?? '';

  const clauses = [descriptor];
  const materials = Array.isArray(identity.material) ? identity.material.filter(Boolean) : [];
  if (materials.length > 0) clauses.push(`in ${materials.join(', ')}`);
  if (brand) clauses.push(`from ${brand}`);
  const sentence = clauses.join(' ');
  return identity.status === 'partial'
    ? `${sentence}. Some details were not confirmed.`
    : sentence;
}

/** Bounded, user-facing copy per non-evidence state. Never blames the photo. */
export const ELISE_ITEM_STATE_COPY: Record<EliseFashionItemState, string | null> = {
  ready: null,
  partial: 'Partly identified',
  insufficient_evidence: 'Could not see enough detail',
  non_fashion: 'No clothing found',
  technical_failure: 'Could not analyze — tap to retry',
};

/**
 * True when this state should offer the user a retry.
 *
 * `non_fashion` deliberately does not: the backend understood the image and
 * found no garment, so retrying the same image would produce the same answer.
 */
export function isRetryableItemState(state: EliseFashionItemState): boolean {
  return state === 'insufficient_evidence' || state === 'technical_failure';
}
