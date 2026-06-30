/**
 * Scan Result Object + Style Memory helpers (Part 1 — Foundation).
 *
 * Pure, side-effect-free functions only:
 *   - createScanResultObject(input, options?)
 *   - createResultCardViewModel(scanResultObject)
 *   - createStyleMemoryItem(scanResultObject, options?)
 *   - compareScanResults(a, b)
 *   - createShareReadyPayload(scanResultObject)
 *
 * No network calls. No Supabase writes. No AsyncStorage writes. No file writes.
 * No UI side effects. Imports are TYPE-ONLY so the module stays loadable by the
 * VM-sandboxed test harness without a requireMap (mirrors
 * services/scanIdentificationMapper.ts).
 *
 * PRIVACY: hero images come only from catalog/product match fields. A blocklist
 * of raw/local image keys is never read. See docs/scan-result-style-memory.md.
 */

import type {
  RankedScanProduct,
  DetailedIdentification,
  FashionAttributes,
  DisplayResult,
} from '../types/scanIdentification';
import type {
  ScanResultObject,
  ScanResultSource,
  ScanConfidenceLabel,
  ScanMissingSignal,
  ScanItemAttributes,
  ScanResultVisual,
  ResultCardViewModel,
  StyleMemoryItem,
  ScanComparisonResult,
  ShareReadyPayload,
} from '../types/scanResultObject';

/** Mapped-analysis metadata subset (kept inline to avoid coupling to mapper). */
type MappedMetadataLike = {
  category?: string | null;
  color?: string | null;
  silhouette?: string | null;
  itemType?: string | null;
  materialEstimate?: string | null;
  pattern?: string | null;
  texture?: string | null;
  occasion?: string | null;
  styleTags?: string[] | null;
  confidenceScore?: number | null;
};

/**
 * Flexible input: accepts a ScanIdentifyResponse-like object and/or a
 * MappedScanAnalysis-like object. We read defensively from whichever fields are
 * present so callers never have to assume a new scan response contract.
 */
export type CreateScanResultInput = {
  // ScanIdentifyResponse-shaped fields
  scanId?: string | null;
  identification?: DetailedIdentification | null;
  attributes?: FashionAttributes | null;
  displayResult?: DisplayResult | null;
  recommendedProducts?: RankedScanProduct[] | null;
  // MappedScanAnalysis-shaped fields (alternate shape)
  metadata?: MappedMetadataLike | null;
  result?: string | null;
  products?: RankedScanProduct[] | null;
  source?: string | null;
};

export type CreateScanResultOptions = {
  id?: string;
  createdAt?: string;
  userId?: string | null;
  source?: ScanResultSource;
  piiMasked?: boolean;
};

export type CreateStyleMemoryOptions = {
  id?: string;
  createdAt?: string;
  userTags?: string[];
  notes?: string;
  savedToDressingRoomId?: string | null;
};

const DEFAULT_PRIVACY_NOTE =
  'Structured fashion metadata and safe catalog references only. No raw scan image, user photo, face, location, or PII.';

/**
 * Catalog/product image keys considered SAFE to read for the hero image.
 * Mirrors ProductShelf.getProductImageUrl.
 */
const SAFE_PRODUCT_IMAGE_KEYS = [
  'imageUrl',
  'image_url',
  'thumbnail',
  'thumbnailUrl',
  'image_src',
  'product_image_url',
] as const;

/**
 * Raw / local / user-capture image keys that must NEVER become a hero image.
 * Explicit blocklist so a stray field can't leak a private image URL.
 */
const BLOCKED_IMAGE_KEYS = [
  'localImageUri',
  'capturedImageUri',
  'rawImageUri',
  'rawImageUrl',
  'uri',
  'localUri',
  'photoUri',
  'cameraUri',
  'sourceImageUri',
  'userImageUrl',
] as const;

// ── small pure utilities ──────────────────────────────────────────────────────

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry);
    if (text) out.push(text);
  }
  return out;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Counter fallback so generated ids are unique within a process tick. */
let __idCounter = 0;

function generateId(prefix: string): string {
  __idCounter += 1;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${time}_${rand}_${__idCounter.toString(36)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSource(source?: string | null): ScanResultSource {
  const s = cleanText(source).toLowerCase();
  if (!s) return 'unknown';
  if (s === 'camera' || s === 'live_scan' || s === 'scan' || s.includes('camera')) {
    return 'camera';
  }
  if (s === 'upload' || s.includes('upload') || s.includes('inspiration')) {
    return 'upload';
  }
  if (s === 'room' || s.includes('room') || s.includes('library')) {
    return 'room';
  }
  return 'unknown';
}

/**
 * Resolve a SAFE hero image URL from a product match. Reads only allow-listed
 * catalog image keys and rejects anything on the blocklist. Returns null if no
 * safe remote URL is present.
 */
function resolveSafeProductImage(product: RankedScanProduct | null | undefined): string | null {
  if (!product || typeof product !== 'object') return null;
  const record = product as Record<string, unknown>;
  for (const key of SAFE_PRODUCT_IMAGE_KEYS) {
    if (BLOCKED_IMAGE_KEYS.includes(key as (typeof BLOCKED_IMAGE_KEYS)[number])) continue;
    const candidate = cleanText(record[key]);
    if (candidate && isHttpUrl(candidate)) return candidate;
  }
  return null;
}

function getProductTitle(product: RankedScanProduct | null | undefined): string {
  if (!product) return '';
  const record = product as Record<string, unknown>;
  return (
    cleanText(record.displayName) ||
    cleanText(record.title) ||
    cleanText(record.name) ||
    cleanText(record.product_name)
  );
}

// ── field resolution ──────────────────────────────────────────────────────────

function resolveColor(
  id: DetailedIdentification | undefined,
  attrs: FashionAttributes | undefined,
  meta: MappedMetadataLike | undefined,
): string {
  if (id?.primary_color) {
    const colors = [cleanText(id.primary_color)];
    colors.push(...asStringArray(id.secondary_colors));
    return dedupe(colors.filter(Boolean)).join(', ');
  }
  // Defensive: tolerate a normalized color field if present on the payload.
  const normalized = cleanText((id as Record<string, unknown> | undefined)?.color_normalized);
  if (normalized) return normalized;
  const palette = asStringArray(attrs?.colorPalette);
  if (palette.length) return dedupe(palette).join(', ');
  return cleanText(meta?.color);
}

function resolvePalette(
  id: DetailedIdentification | undefined,
  attrs: FashionAttributes | undefined,
  meta: MappedMetadataLike | undefined,
): string[] {
  const palette: string[] = [];
  if (id?.primary_color) palette.push(cleanText(id.primary_color));
  palette.push(...asStringArray(id?.secondary_colors));
  palette.push(...asStringArray(attrs?.colorPalette));
  if (!palette.length) {
    const metaColor = cleanText(meta?.color);
    if (metaColor) {
      palette.push(...metaColor.split(',').map((c) => c.trim()).filter(Boolean));
    }
  }
  return dedupe(palette.filter(Boolean));
}

function resolveItemAttributes(input: CreateScanResultInput): ScanItemAttributes {
  const id = input.identification ?? undefined;
  const attrs = input.attributes ?? undefined;
  const meta = input.metadata ?? undefined;
  const idRecord = (id as Record<string, unknown> | undefined) ?? {};

  const category =
    cleanText(id?.item_type) ||
    cleanText(idRecord.canonical_category) ||
    cleanText(attrs?.category) ||
    cleanText(meta?.category) ||
    cleanText(meta?.itemType);

  const subcategory =
    cleanText(id?.subtype) ||
    cleanText(attrs?.itemType) ||
    cleanText(meta?.itemType);

  const silhouette =
    cleanText(id?.silhouette) ||
    cleanText(attrs?.silhouette) ||
    cleanText(meta?.silhouette);

  const material =
    cleanText(id?.material_estimate) ||
    cleanText(attrs?.materialEstimate) ||
    cleanText(meta?.materialEstimate);

  const pattern =
    cleanText(id?.pattern) ||
    cleanText(attrs?.pattern) ||
    cleanText(meta?.pattern);

  const fit = cleanText(id?.fit);

  const occasionTags = dedupe([
    ...asStringArray(id?.occasion_tags),
    ...(attrs?.occasion ? [cleanText(attrs.occasion)] : []),
    ...(meta?.occasion ? [cleanText(meta.occasion)] : []),
  ]);

  const styleTags = dedupe([
    ...asStringArray(id?.style_tags),
    ...asStringArray(attrs?.styleTags),
    ...asStringArray(meta?.styleTags),
  ]);

  let confidence: number | null = null;
  const rawConfidence =
    typeof id?.confidence_score === 'number'
      ? id.confidence_score
      : typeof attrs?.confidenceScore === 'number'
        ? attrs.confidenceScore
        : typeof meta?.confidenceScore === 'number'
          ? meta.confidenceScore
          : null;
  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    confidence = Math.min(1, Math.max(0, rawConfidence));
  }

  return {
    category,
    subcategory,
    silhouette,
    color: resolveColor(id, attrs, meta),
    material,
    pattern,
    fit,
    occasionTags,
    styleTags,
    confidence,
  };
}

// ── confidence + explainability ───────────────────────────────────────────────

function hasBrandIdentity(input: CreateScanResultInput): boolean {
  const id = input.identification ?? undefined;
  if (cleanText(id?.brand_guess)) return true;
  if (cleanText(id?.visible_brand_text)) return true;
  return id?.logo_detected === true;
}

function deriveConfidenceLabel(
  item: ScanItemAttributes,
  input: CreateScanResultInput,
  matchCount: number,
): ScanConfidenceLabel {
  // Honor an explicit displayResult label when it's already one of ours.
  const explicit = cleanText(input.displayResult?.confidenceLabel).toLowerCase();
  if (
    explicit === 'high' ||
    explicit === 'medium' ||
    explicit === 'low' ||
    explicit === 'exploratory'
  ) {
    return explicit as ScanConfidenceLabel;
  }

  const weakIdentity = !hasBrandIdentity(input) && matchCount === 0;
  const score = item.confidence;

  if (score == null) {
    // No numeric signal: lean exploratory unless we at least found matches.
    return matchCount > 0 ? 'low' : 'exploratory';
  }
  if (weakIdentity) {
    // Cap weak-identity scans at low/exploratory regardless of raw score.
    return score >= 0.55 ? 'low' : 'exploratory';
  }
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  if (score >= 0.3) return 'low';
  return 'exploratory';
}

function computeMissingSignals(
  item: ScanItemAttributes,
  input: CreateScanResultInput,
  heroImageUrl: string | null,
): ScanMissingSignal[] {
  const missing: ScanMissingSignal[] = [];
  if (!hasBrandIdentity(input)) missing.push('brand');
  if (!cleanText(input.identification?.subtype) && !item.subcategory) {
    missing.push('exact product name');
  }
  if (!heroImageUrl) missing.push('product image');
  if (!item.material) missing.push('material');
  if (!item.color) missing.push('color');
  if (!item.category) missing.push('category');
  return missing;
}

// ── card title / subtitle ─────────────────────────────────────────────────────

function buildCardTitle(item: ScanItemAttributes, confidence: ScanConfidenceLabel): string {
  const parts = [item.color, item.material, item.category].map((p) => cleanText(p)).filter(Boolean);
  if (item.category && (item.color || item.material)) {
    // "Black leather jacket"
    return capitalizeFirst(parts.join(' '));
  }
  if (item.category) {
    // "Jacket"
    return capitalizeFirst(item.category);
  }
  if (confidence === 'exploratory' || confidence === 'low') {
    return 'Style match found';
  }
  return 'Style match found';
}

function buildCardSubtitle(
  item: ScanItemAttributes,
  matchCount: number,
  confidence: ScanConfidenceLabel,
): string {
  const weak = confidence === 'exploratory' || (!item.category && confidence === 'low');
  if (matchCount > 0) {
    if (weak) return 'Style match found — exact item still learning';
    const noun = matchCount === 1 ? 'close match' : 'close matches';
    return `${matchCount} ${noun} found`;
  }
  if (weak) return 'Style match found — exact item still learning';
  return 'No catalog matches yet — saved as style metadata';
}

function capitalizeFirst(value: string): string {
  const text = cleanText(value);
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildBadges(item: ScanItemAttributes): string[] {
  const badges: string[] = [];
  if (item.category) badges.push(item.category);
  badges.push(...item.styleTags.slice(0, 3));
  if (item.occasionTags[0]) badges.push(item.occasionTags[0]);
  return dedupe(badges.map(capitalizeFirst)).slice(0, 5);
}

function buildVisual(
  item: ScanItemAttributes,
  matches: RankedScanProduct[],
  confidence: ScanConfidenceLabel,
  heroImageUrl: string | null,
): ScanResultVisual {
  return {
    cardTitle: buildCardTitle(item, confidence),
    cardSubtitle: buildCardSubtitle(item, matches.length, confidence),
    heroImageUrl,
    palette: [],
    badges: buildBadges(item),
  };
}

function buildWhyThisMatched(
  item: ScanItemAttributes,
  matches: RankedScanProduct[],
): string {
  const signals = [item.category, item.color, item.material]
    .map((s) => cleanText(s))
    .filter(Boolean);
  if (matches.length && signals.length) {
    return `Matched on ${signals.join(', ')} against ${matches.length} catalog ${
      matches.length === 1 ? 'candidate' : 'candidates'
    }.`;
  }
  if (signals.length) {
    return `Identified ${signals.join(', ')} from the scan. No catalog match yet.`;
  }
  return 'Limited signal from this scan — saved as exploratory style metadata.';
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Normalize a scan-identify result (or mapped analysis) into a
 * {@link ScanResultObject}. Pure: returns a new object, mutates nothing.
 */
export function createScanResultObject(
  input: CreateScanResultInput,
  options: CreateScanResultOptions = {},
): ScanResultObject {
  const safeInput: CreateScanResultInput = input && typeof input === 'object' ? input : {};

  const matchesRaw = Array.isArray(safeInput.recommendedProducts)
    ? safeInput.recommendedProducts
    : Array.isArray(safeInput.products)
      ? safeInput.products
      : [];
  const matches = matchesRaw.filter((m): m is RankedScanProduct => !!m && typeof m === 'object');

  const item = resolveItemAttributes(safeInput);
  const heroImageUrl = resolveSafeProductImage(matches[0]);
  const palette = resolvePalette(
    safeInput.identification ?? undefined,
    safeInput.attributes ?? undefined,
    safeInput.metadata ?? undefined,
  );

  const confidenceLabel = deriveConfidenceLabel(item, safeInput, matches.length);
  const visual = buildVisual(item, matches, confidenceLabel, heroImageUrl);
  visual.palette = palette;

  const missingSignals = computeMissingSignals(item, safeInput, heroImageUrl);

  const userId =
    typeof options.userId === 'string' && options.userId.trim() ? options.userId : null;

  return {
    id: cleanText(options.id) || cleanText(safeInput.scanId) || generateId('scan'),
    createdAt: cleanText(options.createdAt) || nowIso(),
    userId,
    source: options.source ?? normalizeSource(safeInput.source),
    privacy: {
      piiMasked: options.piiMasked ?? true,
      rawImageStored: false,
      cloudPhotoStorage: false,
      notes: DEFAULT_PRIVACY_NOTE,
    },
    item,
    visual,
    matches,
    memory: {
      saved: false,
      comparedWithIds: [],
      sharePayloadReady: false,
      userTags: [],
    },
    explainability: {
      whyThisMatched: buildWhyThisMatched(item, matches),
      missingSignals,
      confidenceLabel,
    },
  };
}

/** Derive a render-ready card view model from a scan result object. Pure. */
export function createResultCardViewModel(
  scanResultObject: ScanResultObject,
): ResultCardViewModel {
  const sro =
    scanResultObject && typeof scanResultObject === 'object'
      ? scanResultObject
      : createScanResultObject({});
  const matches = Array.isArray(sro.matches) ? sro.matches : [];
  return {
    title: sro.visual.cardTitle,
    subtitle: sro.visual.cardSubtitle,
    heroImageUrl: sro.visual.heroImageUrl ?? null,
    badges: Array.isArray(sro.visual.badges) ? sro.visual.badges : [],
    confidenceLabel: sro.explainability.confidenceLabel,
    primaryMatch: matches[0] ?? null,
    matchCount: matches.length,
    saveEnabled: true,
    shareEnabled: true,
    compareEnabled: true,
    privacyCaption: 'Saved as style metadata, not a raw photo.',
  };
}

/**
 * Build a metadata-only {@link StyleMemoryItem} from a scan result. Pure — does
 * NOT persist. In Part 2 a Save action wraps the existing Dressing Room save
 * path and records the resulting id on `savedToDressingRoomId`.
 */
export function createStyleMemoryItem(
  scanResultObject: ScanResultObject,
  options: CreateStyleMemoryOptions = {},
): StyleMemoryItem {
  const sro =
    scanResultObject && typeof scanResultObject === 'object'
      ? scanResultObject
      : createScanResultObject({});
  return {
    id: cleanText(options.id) || generateId('mem'),
    scanResultId: sro.id,
    createdAt: cleanText(options.createdAt) || nowIso(),
    item: sro.item,
    visual: sro.visual,
    matches: Array.isArray(sro.matches) ? sro.matches : [],
    userTags: Array.isArray(options.userTags) ? dedupe(asStringArray(options.userTags)) : [],
    notes: cleanText(options.notes),
    savedToDressingRoomId: options.savedToDressingRoomId ?? null,
    source: 'scan',
    privacy: sro.privacy,
  };
}

/** Intersect two string arrays case-insensitively, preserving `a`'s casing. */
function sharedValues(a: string[], b: string[]): string[] {
  const bset = new Set(b.map((v) => v.toLowerCase()));
  return dedupe(a.filter((v) => bset.has(v.toLowerCase())));
}

function splitColors(color: string): string[] {
  return dedupe(
    cleanText(color)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  );
}

/**
 * Pure metadata comparison of two scan results. No DB, no history loading.
 * similarityScore is a weighted Jaccard-style overlap across attributes.
 */
export function compareScanResults(
  a: ScanResultObject,
  b: ScanResultObject,
): ScanComparisonResult {
  const itemA = a?.item ?? createScanResultObject({}).item;
  const itemB = b?.item ?? createScanResultObject({}).item;

  const sharedCategories = sharedValues(
    [itemA.category, itemA.subcategory].filter(Boolean),
    [itemB.category, itemB.subcategory].filter(Boolean),
  );
  const sharedColors = sharedValues(splitColors(itemA.color), splitColors(itemB.color));
  const sharedMaterials = sharedValues(
    itemA.material ? [itemA.material] : [],
    itemB.material ? [itemB.material] : [],
  );
  const sharedStyleTags = sharedValues(itemA.styleTags, itemB.styleTags);
  const sharedOccasionTags = sharedValues(itemA.occasionTags, itemB.occasionTags);

  // Weighted dimensions → similarity 0..1. Only dimensions where at least one
  // side has data count toward the denominator.
  const dimensions: Array<{ weight: number; a: string[]; b: string[]; shared: string[] }> = [
    {
      weight: 0.3,
      a: [itemA.category, itemA.subcategory].filter(Boolean),
      b: [itemB.category, itemB.subcategory].filter(Boolean),
      shared: sharedCategories,
    },
    { weight: 0.2, a: splitColors(itemA.color), b: splitColors(itemB.color), shared: sharedColors },
    {
      weight: 0.15,
      a: itemA.material ? [itemA.material] : [],
      b: itemB.material ? [itemB.material] : [],
      shared: sharedMaterials,
    },
    { weight: 0.25, a: itemA.styleTags, b: itemB.styleTags, shared: sharedStyleTags },
    { weight: 0.1, a: itemA.occasionTags, b: itemB.occasionTags, shared: sharedOccasionTags },
  ];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const dim of dimensions) {
    const union = dedupe([...dim.a, ...dim.b].map((v) => v.toLowerCase()));
    if (union.length === 0) continue;
    weightTotal += dim.weight;
    weightedSum += dim.weight * (dim.shared.length / union.length);
  }
  const similarityScore = weightTotal > 0 ? round2(weightedSum / weightTotal) : 0;

  const differences: string[] = [];
  pushDifference(differences, 'category', itemA.category, itemB.category);
  pushDifference(differences, 'color', itemA.color, itemB.color);
  pushDifference(differences, 'material', itemA.material, itemB.material);
  pushDifference(differences, 'silhouette', itemA.silhouette, itemB.silhouette);

  return {
    similarityScore,
    sharedCategories,
    sharedColors,
    sharedMaterials,
    sharedStyleTags,
    sharedOccasionTags,
    differences,
    summary: buildComparisonSummary(itemA, itemB, similarityScore, sharedStyleTags, differences),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pushDifference(out: string[], label: string, a: string, b: string): void {
  const av = cleanText(a);
  const bv = cleanText(b);
  if (av && bv && av.toLowerCase() !== bv.toLowerCase()) {
    out.push(`${label}: ${av} vs ${bv}`);
  }
}

function buildComparisonSummary(
  a: ScanItemAttributes,
  b: ScanItemAttributes,
  score: number,
  sharedStyleTags: string[],
  differences: string[],
): string {
  const lean = sharedStyleTags[0] || a.category || b.category || 'these pieces';
  const closeness = score >= 0.66 ? 'closely align' : score >= 0.33 ? 'partly overlap' : 'differ';
  const diffPhrase = differences.length
    ? ` but differ in ${differences
        .slice(0, 2)
        .map((d) => d.split(':')[0])
        .join(' and ')}`
    : '';
  return `Both scans ${closeness} around ${lean}${diffPhrase}.`;
}

/**
 * Build a SAFE share payload. Includes only id, createdAt, item, visual, and
 * matches. Excludes userId, privacy, memory notes, and any raw/local image or
 * PII field.
 *
 * NOTE: Actual sharing requires deep-link and backend share-resolution
 * infrastructure and is deferred to Part 2 or later. This returns data only.
 */
export function createShareReadyPayload(scanResultObject: ScanResultObject): ShareReadyPayload {
  const sro =
    scanResultObject && typeof scanResultObject === 'object'
      ? scanResultObject
      : createScanResultObject({});
  return {
    id: sro.id,
    createdAt: sro.createdAt,
    item: sro.item,
    visual: sro.visual,
    matches: Array.isArray(sro.matches) ? sro.matches : [],
  };
}
