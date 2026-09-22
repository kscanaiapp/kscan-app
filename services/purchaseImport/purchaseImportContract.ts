// Receipt & Purchase Intelligence V1 — the shared contract.
//
// WHAT THIS FEATURE IS: a customer gives K Scan an order confirmation or a
// receipt, K Scan extracts fashion-purchase metadata, the customer reviews and
// corrects it, and ONE explicit confirmation writes owned Closet items through
// the existing ownership authority (services/closetLibrary.js#createClosetItem).
//
// THE INVARIANT EVERY FILE IN services/purchaseImport/ SERVES:
//
//     purchase evidence  !=  ownership
//
// Uploading, extracting and reviewing create nothing. Only a user confirmation
// followed by a successful authoritative Closet write makes an item owned.
//
// WHAT THIS FEATURE IS NOT: accounting, expense tracking, a receipt vault, a
// warranty manager, email ingestion or return reconciliation. The raw document
// is processed, reviewed and discarded. Nothing here keeps it.
//
// Three kinds of truth are kept apart, and the provenance vocabulary below is
// how each persisted field says which one it is:
//
//     what the DOCUMENT says      -> RECEIPT_EXPLICIT
//     what the MODEL thinks       -> MODEL_NORMALIZED
//     what the USER confirms      -> USER_CONFIRMED

/** Wire contract version shared with supabase/functions/purchase-import-extract. */
export const PURCHASE_IMPORT_CONTRACT_VERSION = 'purchase-import-v1' as const;

/**
 * Input tiers, ordered by expected quality. The customer picks one before
 * choosing an image. It is a telemetry dimension and a prompt hint only; it
 * never loosens a truth rule.
 */
export const PURCHASE_IMPORT_INPUT_TIERS = [
  'order_confirmation',
  'digital_receipt',
  'paper_receipt',
] as const;
export type PurchaseImportInputTier = typeof PURCHASE_IMPORT_INPUT_TIERS[number];

export function isPurchaseImportInputTier(value: unknown): value is PurchaseImportInputTier {
  return typeof value === 'string' && (PURCHASE_IMPORT_INPUT_TIERS as readonly string[]).includes(value);
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Largest base64 image body accepted. It equals scan-identify's
 * MAX_IMAGE_BASE64_BYTES (2 MiB of base64 characters), the bound this repository
 * already governs for one image to the same provider. The Edge Function
 * enforces the same number, and a parity test pins the two together.
 */
export const PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

/**
 * Longest edge of the processed image. A long screenshot is scaled to
 * PURCHASE_IMPORT_TARGET_WIDTH first. If its height is still above this, it is
 * REFUSED with `file_too_large`, never silently cut (BLOCK-RPI-32). Past this
 * height, line-item text at the target width is too small to read reliably.
 */
export const PURCHASE_IMPORT_MAX_EDGE_PX = 4096;
export const PURCHASE_IMPORT_TARGET_WIDTH = 1280;
export const PURCHASE_IMPORT_JPEG_QUALITY = 0.82;

/**
 * Most purchase lines one import may carry. A document with more lines is
 * refused with `too_many_items`. It is never truncated to the first N, which
 * would quietly drop purchases the customer expects to see.
 */
export const PURCHASE_IMPORT_MAX_ITEMS = 25;

/**
 * Most identical units one line may add. Closet ownership is one record per
 * physical garment (CLOSET_QUANTITY_SEMANTICS=MULTIPLE_IDENTICAL_ITEMS), so a
 * line reading "Qty 3" can add up to three records, never more than the
 * document says and never more than this bound.
 */
export const PURCHASE_IMPORT_MAX_UNITS_PER_LINE = 10;

// ── Confidence ───────────────────────────────────────────────────────────────

/**
 * Document-confidence floor (BLOCK-RPI-27). Below it the import is
 * `unreadable` and produces ZERO candidates, whatever items the model listed.
 *
 * WHY 0.5 AND WHY HERE: the extraction prompt defines documentConfidence as
 * "the fraction of the purchased-item text you could read with certainty". 0.5
 * is the point where the model says it could not read at least half the item
 * text. Below that, a candidate list is a guess about a document it mostly
 * could not see. The value lives in ONE place per runtime: here, and in
 * supabase/functions/purchase-import-extract/extraction.ts. A parity test pins
 * the two. It is a starting calibration, not a measured one. The owner corpus
 * (spec section 41) is the evidence that should move it, and the decision log
 * records that it has not yet been measured.
 */
export const PURCHASE_IMPORT_DOCUMENT_CONFIDENCE_FLOOR = 0.5;

/** Per-line floor. A line under it is dropped as unreadable, never guessed. */
export const PURCHASE_IMPORT_ITEM_CONFIDENCE_FLOOR = 0.35;

/** A kept line under this is shown with an explicit "Check this" marker. */
export const PURCHASE_IMPORT_ITEM_REVIEW_THRESHOLD = 0.6;

// ── Classification vocabulary ────────────────────────────────────────────────

/**
 * What a document line is. Only the first five can become Closet candidates.
 * Beauty and fragrance are fashion-adjacent but are not Closet garments in V1
 * (spec section 14). They are excluded rather than offered for re-classification.
 */
export const PURCHASE_LINE_CLASSES = [
  'apparel',
  'footwear',
  'bag',
  'accessory',
  'jewelry',
  'beauty',
  'fragrance',
  'non_fashion',
  'gift_card',
  'shipping',
  'tax',
  'discount',
  'fee',
  'payment',
  'unknown',
] as const;
export type PurchaseLineClass = typeof PURCHASE_LINE_CLASSES[number];

export const PURCHASE_CLOSET_LINE_CLASSES: readonly PurchaseLineClass[] = [
  'apparel',
  'footwear',
  'bag',
  'accessory',
  'jewelry',
];

/** Direction of a line. A return or refund is never a new owned garment. */
export const PURCHASE_LINE_KINDS = ['purchase', 'return', 'refund', 'exchange', 'unknown'] as const;
export type PurchaseLineKind = typeof PURCHASE_LINE_KINDS[number];

export const PURCHASE_DOCUMENT_KINDS = ['purchase', 'return', 'exchange', 'mixed', 'unknown'] as const;
export type PurchaseDocumentKind = typeof PURCHASE_DOCUMENT_KINDS[number];

/**
 * Closet category values a purchase line may be mapped to. The Closet stores
 * `category` as bounded free text. These are the coarse garment families the
 * rest of K Scan already speaks: VTO eligibility uses top/outerwear/dress, and
 * the Closet inventory lens groups by the stored value. The customer can still
 * edit the category in review.
 */
export const PURCHASE_CLOSET_CATEGORIES = [
  'top',
  'bottom',
  'dress',
  'outerwear',
  'footwear',
  'bag',
  'accessory',
  'jewelry',
  'activewear',
  'swimwear',
  'sleepwear',
  'underwear',
] as const;
export type PurchaseClosetCategory = typeof PURCHASE_CLOSET_CATEGORIES[number];

export const CURRENCY_EVIDENCE = ['explicit_code', 'explicit_symbol', 'none'] as const;
export type CurrencyEvidence = typeof CURRENCY_EVIDENCE[number];

export const BRAND_EVIDENCE = ['on_item_line', 'none'] as const;
export type BrandEvidence = typeof BRAND_EVIDENCE[number];

// ── Provenance ───────────────────────────────────────────────────────────────

/**
 * Provenance of one persisted or editable field.
 *
 * KSCAN_VERIFIED_PRODUCT is declared for contract completeness and is never
 * produced in V1: no deterministic K Scan product identity exists for a
 * purchase line (PURCHASE_IDENTITY_CAPABILITY=NONE), and fuzzy-matching a
 * receipt line to a catalogue product is forbidden (spec section 13).
 */
export const PURCHASE_FIELD_PROVENANCE = [
  'RECEIPT_EXPLICIT',
  'KSCAN_VERIFIED_PRODUCT',
  'MODEL_NORMALIZED',
  'USER_CONFIRMED',
  'UNKNOWN',
] as const;
export type PurchaseFieldProvenance = typeof PURCHASE_FIELD_PROVENANCE[number];

export function isPurchaseFieldProvenance(value: unknown): value is PurchaseFieldProvenance {
  return typeof value === 'string' && (PURCHASE_FIELD_PROVENANCE as readonly string[]).includes(value);
}

/** Every field a confirmed item may carry provenance for. Named once. */
export const PURCHASE_PROVENANCE_FIELDS = [
  'title',
  'brand',
  'category',
  'subtype',
  'primaryColor',
  'material',
  'size',
  'pricePaid',
  'currency',
  'merchant',
  'purchaseDate',
  'sku',
  'gtin',
  'retailerProductRef',
  'returnDeadline',
] as const;
export type PurchaseProvenanceField = typeof PURCHASE_PROVENANCE_FIELDS[number];

// ── Wire shape (Edge Function -> client) ────────────────────────────────────

/** One sanitized document line, as the Edge Function returns it. */
export type PurchaseWireItem = {
  /** Verbatim item text as printed, scrubbed of contact and payment data. Display only. */
  sourceLine: string | null;
  title: string | null;
  brand: string | null;
  brandEvidence: BrandEvidence;
  lineClass: PurchaseLineClass;
  lineKind: PurchaseLineKind;
  category: PurchaseClosetCategory | null;
  subtype: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
  /** Purchased size exactly as written. Never normalized. */
  sizeRaw: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  sku: string | null;
  gtin: string | null;
  retailerProductRef: string | null;
  confidence: number;
};

export type PurchaseWireDocument = {
  merchant: string | null;
  purchaseDate: string | null;
  currencyCode: string | null;
  currencySymbol: string | null;
  currencyEvidence: CurrencyEvidence;
  explicitReturnDeadline: string | null;
  documentKind: PurchaseDocumentKind;
  documentConfidence: number;
};

export type PurchaseWireSuccess = {
  ok: true;
  contractVersion: typeof PURCHASE_IMPORT_CONTRACT_VERSION;
  document: PurchaseWireDocument;
  items: PurchaseWireItem[];
};

export type PurchaseWireFailure = {
  ok: false;
  contractVersion: typeof PURCHASE_IMPORT_CONTRACT_VERSION;
  errorClass: PurchaseImportServerErrorClass;
  retryAfterSeconds?: number | null;
};

/** Failure classes the server may return. A subset of the client taxonomy. */
export const PURCHASE_IMPORT_SERVER_ERROR_CLASSES = [
  'invalid_file',
  'file_too_large',
  'unreadable_document',
  'too_many_items',
  'provider_unavailable',
  'schema_validation_failed',
  'unauthorized',
  'rate_limited',
  'feature_disabled',
] as const;
export type PurchaseImportServerErrorClass = typeof PURCHASE_IMPORT_SERVER_ERROR_CLASSES[number];

// ── Persisted purchase provenance (Closet record) ───────────────────────────

/**
 * The bounded purchase provenance a confirmed Closet item may carry.
 *
 * DELIBERATELY ABSENT, and never to be added: the raw receipt, OCR text, the
 * source line, address, email, phone, card data, loyalty number, order number,
 * tracking number, and any provider request or response (spec sections 23-24).
 * `pricePaid` and `currency` are both present or both null: an amount with no
 * known currency is not persisted (BLOCK-RPI-29).
 */
export type ClosetPurchaseProvenance = {
  source: 'purchase_import';
  contractVersion: typeof PURCHASE_IMPORT_CONTRACT_VERSION;
  inputTier: PurchaseImportInputTier;
  merchant: string | null;
  purchaseDate: string | null;
  pricePaid: number | null;
  currency: string | null;
  sku: string | null;
  gtin: string | null;
  retailerProductRef: string | null;
  returnDeadline: string | null;
  /** 'document' when the deadline is one document-level policy every item inherits. */
  returnDeadlineScope: 'document' | null;
  fieldProvenance: Partial<Record<PurchaseProvenanceField, PurchaseFieldProvenance>>;
};
