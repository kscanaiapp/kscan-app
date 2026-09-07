/**
 * The governed Live-VTO asset registry -- the narrow, explicit answer to
 * "which productRef values currently address a real, governed `.ksgarment`
 * asset the native Live runtime can load".
 *
 * WHY THIS EXISTS. Before this file, `loadGarment`/`switchGarment` resolved
 * EVERY descriptor to the SAME bundled native fixture regardless of the
 * requested `productRef` (documented as a deliberate, bounded placeholder in
 * docs/vto-live-bridge-contract.md §13.5). There is no live product-catalog
 * network resolver anywhere in this codebase, and building one is explicitly
 * out of this mission's scope (see the mission's NETWORK BOUNDARY / CACHE
 * sections) -- `vto-phase4-pipeline/` is an offline batch tool, not a
 * runtime dependency. What DOES already exist, real and governed, is the
 * small set of Phase-4-produced `.ksgarment` manifests that are bundled as
 * native fixtures (`modules/kscan-live-vto-native/{android/src/main/assets,
 * ios/Assets}/{n1b-fixture,n1c-asym-fixture}/manifest.json`). This registry
 * is the narrowest existing authority: it indexes those REAL manifests by
 * the one field they already carry for exactly this purpose --
 * `productIdentity.productRef` -- rather than inventing a second asset
 * format or a second product-id system.
 *
 * WHY THE ENTRIES ARE HAND-DECLARED, NOT READ OFF DISK AT RUNTIME. The real
 * manifest.json files live under the native module's asset directories,
 * which are compiled into the Android APK / iOS bundle, not the Metro JS
 * bundle -- there is no `fs` access to them from application JS at runtime.
 * Re-declaring the identity fields here (not the full manifest -- assetKey/
 * assetId/assetVersion/productRef/category/eligibility only) mirrors the
 * EXISTING, established pattern in this codebase for the `.ksgarment`
 * contract itself (see vto-phase4-pipeline/src/garmentContract.ts's header,
 * and LiveVtoGarment.kt/.swift's): re-declare a small, cited surface rather
 * than cross-import a package this runtime does not depend on.
 *
 * DRIFT IS CAUGHT MECHANICALLY, NOT BY HAND. Unlike a comment asking a human
 * to keep two files in sync, __tests__/vtoLiveGarmentRegistryParity.test.js
 * reads the ACTUAL bundled manifest.json/texture.png/alpha.png files off
 * disk (both platforms) with Node's `fs`/`crypto` and asserts every field
 * declared below, and the platform parity of the underlying asset bytes,
 * match reality. A future asset added to the registry without updating (or
 * breaking) that test has not really been added.
 *
 * MOST REAL productRef VALUES WILL NOT BE IN THIS LIST. That is success, not
 * a bug: Commerce's `productRef` (services/vto/vtoCommerceGarment.ts) is a
 * correlation handle for an ephemeral per-scan result, not a stable catalog
 * SKU, and the Phase 4 asset factory has only ever been run against a
 * synthetic/research corpus and a bounded real-catalog benchmark (project
 * memory: Gate E found 3/220 real products LIVE2D_ELIGIBLE). A resolver
 * that returned ELIGIBLE for arbitrary real productRefs would be lying.
 */

export const LIVE_VTO_ASSET_KEY_ALLOWLIST = ['n1b-fixture', 'n1c-asym-fixture'] as const;
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
];

/** Exact-match lookup by commerce productRef. Returns null (NOT_FOUND, not a
 *  throw) for anything not in the registry -- the expected outcome for the
 *  overwhelming majority of real productRef values. */
export function findGovernedLiveAssetByProductRef(
  productRef: string,
  registry: readonly LiveVtoGovernedAssetEntry[] = LIVE_VTO_GOVERNED_ASSETS,
): LiveVtoGovernedAssetEntry | null {
  return registry.find((entry) => entry.productRef === productRef) ?? null;
}
