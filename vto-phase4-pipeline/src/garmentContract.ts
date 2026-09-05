/**
 * Re-declaration of the `.ksgarment` contract, read-only-cited from the
 * PR #291/#295 research workspace (`kscan-live-vto/packages/garment-contract/
 * src/ksgarment.ts` and `garmentDescriptor.ts`, at PR #295 head
 * 266ab1a8538ed73b91a50e58f7089ae41b784c2b). Not copied mechanically — that
 * workspace is a disjoint git history from this branch's base
 * (`integration/backend-kplus-complimentary-staging-v1`) and is not merged
 * here; the field names, control-point ids, coordinate convention, and
 * schema-version literal below are reproduced field-for-field so a future
 * merge of the two lines needs no schema reconciliation.
 *
 * See docs/vto-phase4-source-authority.md for the full citation.
 */

export const KSGARMENT_SCHEMA_VERSION = '1.0' as const;

export const GARMENT_CONTROL_POINT_IDS = [
  'leftShoulder',
  'rightShoulder',
  'leftArmpit',
  'rightArmpit',
  'leftTorso',
  'rightTorso',
  'waist',
  'leftHem',
  'rightHem',
  'leftSleeve',
  'rightSleeve',
] as const;
export type GarmentControlPointId = (typeof GARMENT_CONTROL_POINT_IDS)[number];

export const MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT: readonly GarmentControlPointId[] = [
  'leftShoulder',
  'rightShoulder',
  'leftHem',
  'rightHem',
];

/** Normalized garment-local texture space (u,v) in [0,1]x[0,1], origin top-left. */
export interface GarmentControlPoint {
  id: GarmentControlPointId;
  u: number;
  v: number;
}

export type MeshDefinition = {
  type: 'grid';
  width: number;
  height: number;
};

export interface KsgarmentManifest {
  version: typeof KSGARMENT_SCHEMA_VERSION;
  productId: string;
  category: string;
  subcategory: string | 'unknown';
  silhouette: string | 'unknown';
  sleeveLength: string;
  garmentLength: string;
  neckline: string;
  controlPoints: GarmentControlPoint[];
  meshDefinition: MeshDefinition;
  /** Relative path within the asset bundle, e.g. "texture.png". */
  texture: string;
  /** Relative path within the asset bundle, e.g. "alpha.png". */
  alphaMask: string;
  assetVersion: string;
}

/**
 * Live's real, currently-shipping template-family allow-list
 * (`LIVE_SUPPORTED_TEMPLATE_FAMILIES`, integration branch
 * `types/vtoLive.ts`). Phase 4 eligibility is expressed in these terms,
 * not an invented taxonomy.
 */
export const LIVE_SUPPORTED_TEMPLATE_FAMILIES = ['t-shirt', 'simple-top', 'sweater'] as const;
export type LiveSupportedTemplateFamily = (typeof LIVE_SUPPORTED_TEMPLATE_FAMILIES)[number];

export function isLiveSupportedTemplateFamily(value: unknown): value is LiveSupportedTemplateFamily {
  return typeof value === 'string' && (LIVE_SUPPORTED_TEMPLATE_FAMILIES as readonly string[]).includes(value);
}

/**
 * The one canonical-category -> template-family mapping that actually
 * exists in the shipping app today (`TEMPLATE_FAMILY_BY_CANONICAL`,
 * `services/vto/vtoLiveGarment.ts`, integration branch, read this session).
 * Phase 4 does not invent finer-grained sub-typing (t-shirt vs sweater)
 * without a real signal for it — see docs/vto-phase4-defect-ledger.md and
 * the eligibility module for why 'top' resolves to 'simple-top' only.
 */
export const TEMPLATE_FAMILY_BY_CANONICAL: Readonly<Record<string, LiveSupportedTemplateFamily>> = {
  top: 'simple-top',
};

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

/** Structural validation only — hand-rolled, no schema-validator dependency, matching the cited source's own approach. */
export function validateKsgarmentManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return { valid: false, errors: ['manifest is not an object'] };
  }
  const m = value as Partial<KsgarmentManifest>;

  if (m.version !== KSGARMENT_SCHEMA_VERSION) errors.push(`version must be "${KSGARMENT_SCHEMA_VERSION}"`);
  if (typeof m.productId !== 'string' || !m.productId) errors.push('productId is required');
  if (typeof m.category !== 'string' || !m.category) errors.push('category is required');
  if (typeof m.texture !== 'string' || !m.texture) errors.push('texture path is required');
  if (typeof m.alphaMask !== 'string' || !m.alphaMask) errors.push('alphaMask path is required');
  if (typeof m.assetVersion !== 'string' || !m.assetVersion) errors.push('assetVersion is required');

  if (!m.meshDefinition || m.meshDefinition.type !== 'grid') {
    errors.push('meshDefinition.type must be "grid"');
  } else {
    if (!Number.isInteger(m.meshDefinition.width) || m.meshDefinition.width < 2) {
      errors.push('meshDefinition.width must be an integer >= 2');
    }
    if (!Number.isInteger(m.meshDefinition.height) || m.meshDefinition.height < 2) {
      errors.push('meshDefinition.height must be an integer >= 2');
    }
  }

  const controlPoints = Array.isArray(m.controlPoints) ? m.controlPoints : [];
  if (!Array.isArray(m.controlPoints)) errors.push('controlPoints must be an array');
  const seenIds = new Set<string>();
  for (const cp of controlPoints) {
    if (!cp || typeof cp !== 'object') {
      errors.push('controlPoint entries must be objects');
      continue;
    }
    if (!(GARMENT_CONTROL_POINT_IDS as readonly string[]).includes((cp as GarmentControlPoint).id)) {
      errors.push(`unknown control point id: ${String((cp as GarmentControlPoint).id)}`);
    } else {
      seenIds.add((cp as GarmentControlPoint).id);
    }
    const u = (cp as GarmentControlPoint).u;
    const v = (cp as GarmentControlPoint).v;
    if (typeof u !== 'number' || u < 0 || u > 1) errors.push(`control point ${String((cp as GarmentControlPoint).id)} has invalid u`);
    if (typeof v !== 'number' || v < 0 || v > 1) errors.push(`control point ${String((cp as GarmentControlPoint).id)} has invalid v`);
  }
  for (const requiredId of MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT) {
    if (!seenIds.has(requiredId)) errors.push(`missing required control point: ${requiredId}`);
  }

  return { valid: errors.length === 0, errors };
}
