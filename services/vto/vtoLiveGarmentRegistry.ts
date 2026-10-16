/** Governed bundled Live assets. Scanner product IDs remain unchanged.
 * Research fixtures resolve only by their explicit IDs. The real pilot also
 * resolves by an approved retailer URL AND matching source image identity.
 * Parity and integrity tests bind each entry to the Android/iOS bundle bytes.
 */

export const LIVE_VTO_ASSET_KEY_ALLOWLIST = ['n1b-fixture', 'n1c-asym-fixture', 'ascolour-5001-black-v1'] as const;
export type LiveVtoAssetKey = (typeof LIVE_VTO_ASSET_KEY_ALLOWLIST)[number];

const ASSET_KEY_SET: ReadonlySet<string> = new Set(LIVE_VTO_ASSET_KEY_ALLOWLIST);

export function isLiveVtoAssetKey(value: unknown): value is LiveVtoAssetKey {
  return typeof value === 'string' && ASSET_KEY_SET.has(value);
}

/**
 * Identity + eligibility fields lifted from a real Phase-4 generated-asset
 * manifest (`fixtures/vto-phase4/generated/<assetId>/manifest.json` shape,
 * the SAME shape bundled verbatim as `<assetKey>/manifest.json`). Not the
 * full manifest -- only what the resolver and the native descriptor need.
 */
export interface LiveVtoGovernedAssetEntry {
  /** Allowlisted bundled-asset directory name both platforms carry
   *  verbatim under their own asset root. The ONLY string native uses to
   *  select which folder to read -- never a caller-supplied path. */
  assetKey: LiveVtoAssetKey;
  /** manifest.assetId. */
  assetId: string;
  /** manifest.assetVersion (== manifest.ksgarment.assetVersion). */
  assetVersion: string;
  /** manifest.ksgarment.version. Compared against KSGARMENT_SCHEMA_VERSION. */
  ksgarmentSchemaVersion: string;
  /** manifest.productIdentity.productRef -- the ONE field this registry is
   *  keyed by. */
  productRef: string;
  /** K Scan canonical category token this asset addresses, e.g. 'top'. */
  canonicalCategory: string;
  templateFamily: 'simple-top' | 't-shirt' | 'sweater';
  /** manifest.eligibility.live2d. */
  eligible: boolean;
  /** manifest.eligibility.reason. */
  ineligibleReason: string | null;
  /** manifest.qa.passed. */
  qaPassed: boolean;
  /** manifest.source.sha256 -- provenance identity, not a rendering input. */
  sourceSha256: string;
  /** Approved retailer URL and exact image identity; variant mismatches fail closed. */
  productUrl?: string;
  sourceImageUrl?: string;
}

export const KSGARMENT_SCHEMA_VERSION = '1.0';

/**
 * The two currently-governed, currently-bundled Live assets. Values copied
 * field-for-field from the real committed manifests -- see the parity test
 * for the mechanical check. `p4-multi-image-product` and `n1c-asym-marker`
 * are the manifests' own `productIdentity.productRef` values; a real
 * deployment would grow this list by running the Phase 4 pipeline keyed by
 * an actual commerce `productRef` and bundling its accepted output the same
 * way these two already are.
 */
export const LIVE_VTO_GOVERNED_ASSETS: readonly LiveVtoGovernedAssetEntry[] = [
  {
    assetKey: 'n1b-fixture',
    assetId: '081350cef7f5c83e05c3e6c1',
    assetVersion: '1',
    ksgarmentSchemaVersion: '1.0',
    productRef: 'p4-multi-image-product',
    canonicalCategory: 'top',
    templateFamily: 'simple-top',
    eligible: true,
    ineligibleReason: null,
    qaPassed: true,
    sourceSha256: '26bdf8130586d29b69b9d149ea3f885807447ef2482c5382f2721a8cdf8aebf1',
  },
  {
    assetKey: 'n1c-asym-fixture',
    assetId: 'n1c-asym-marker-fixture',
    assetVersion: '1',
    ksgarmentSchemaVersion: '1.0',
    productRef: 'n1c-asym-marker',
    canonicalCategory: 'top',
    templateFamily: 'simple-top',
    eligible: true,
    ineligibleReason: null,
    qaPassed: true,
    sourceSha256: '5deca90a677b8ab31f01108b865641eccafb2f3f8f3c21083944acc9adec4393',
  },
  {
    assetKey: 'ascolour-5001-black-v1', assetId: '524ab66a3f16bda5c3d7f9fe', assetVersion: '1',
    ksgarmentSchemaVersion: '1.0', productRef: 'https://ascolour.com/staple-tee-5001/?Colour=Black',
    canonicalCategory: 'top', templateFamily: 'simple-top', eligible: true, ineligibleReason: null,
    qaPassed: true, sourceSha256: '59003a90b1987d5e09b3c86d8f8e29ee0feb07670e73dcb8dc005da35137ce49',
    productUrl: 'https://ascolour.com/staple-tee-5001/?Colour=Black',
    sourceImageUrl: 'https://cdn11.bigcommerce.com/s-hsi95a83fz/images/stencil/850w/products/182/10681/5001_STAPLE_TEE_BLACK__80682.1774216143.jpg',
  },

];

/** Exact-match lookup by commerce productRef. Returns null (NOT_FOUND, not a
 *  throw) for anything not in the registry -- the expected outcome for the
 *  overwhelming majority of real productRef values. */
export function findGovernedLiveAssetByProductRef(
  productRef: string,
  registry: readonly LiveVtoGovernedAssetEntry[] = LIVE_VTO_GOVERNED_ASSETS,
  productUrl?: string,
  imageUrl?: string,
): LiveVtoGovernedAssetEntry | null {
  return registry.find((entry) => (!entry.productUrl && entry.productRef === productRef) || (
    !!entry.productUrl && !!entry.sourceImageUrl &&
    normalizedPilotProduct(productUrl ?? productRef) === normalizedPilotProduct(entry.productUrl) &&
    normalizedPilotImage(imageUrl) === normalizedPilotImage(entry.sourceImageUrl)
  )) ?? null;
}

// Narrow pilot URL matching, not a replacement for Scanner's deterministic ID.
// The colour remains significant; tracking query parameters do not select a variant.
function normalizedPilotProduct(value?: string): string | null {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'ascolour.com') return null;
    if (url.pathname.replace(/\/$/, '') !== '/staple-tee-5001') return null;
    for (const key of url.searchParams.keys()) {
      if (key !== 'Colour' && !key.startsWith('utm_') && !['gclid', 'srsltid'].includes(key)) return null;
    }
    const colours = url.searchParams.getAll('Colour');
    if (colours.length !== 1 || colours[0].toLowerCase() !== 'black') return null;
    return 'ascolour:5001:black';
  } catch { return null; }
}
function normalizedPilotImage(value?: string): string | null {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'cdn11.bigcommerce.com') return null;
    const path = url.pathname.replace(/\/stencil\/[^/]+\//, '/');
    return path.endsWith('/5001_STAPLE_TEE_BLACK__80682.1774216143.jpg') ? path : null;
  } catch { return null; }
}
