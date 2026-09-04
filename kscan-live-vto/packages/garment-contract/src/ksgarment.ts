/**
 * .ksgarment — versioned garment asset bundle (Section P1-D4).
 *
 * "Do not let the renderer hardcode individual products." Every product's
 * garment shows up to the renderer as one of these manifests plus a
 * texture + alpha mask; the renderer only ever knows about
 * `GarmentControlPointId`s and `MeshDefinition`, never a product SKU.
 *
 * On-disk bundle layout (a directory, or a zip of one):
 *   manifest.json   <- KsgarmentManifest, this file's shape
 *   texture.png
 *   alpha.png
 */

import type {
  GarmentCategory,
  GarmentLength,
  Neckline,
  SleeveLength,
} from './garmentDescriptor';

/**
 * Superset of every semantic control point referenced across Phase 1
 * (P1-D4: leftShoulder/rightShoulder/leftHem/rightHem) and Phase 2
 * (P2-C2: + leftTorso/rightTorso/waist/leftSleeve/rightSleeve). One id
 * space so a Phase-1 asset needs no migration to become Phase-2-ready —
 * it just starts with fewer points populated.
 *
 * `leftArmpit`/`rightArmpit` were added during the review-package-#2 topology
 * repair. They are where the sleeve meets the body, and they exist to anchor
 * the TORSO side of that junction: without them the articulated sleeve target
 * was the nearest constraint to the chest and dragged chest content with it
 * as the sleeve rotated onto the arm.
 */
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

/**
 * The minimum control points P1-E1 ("Basic Garment Attachment") requires
 * before centering/scale/orientation can be proven at all.
 */
export const MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT: readonly GarmentControlPointId[] = [
  'leftShoulder',
  'rightShoulder',
  'leftHem',
  'rightHem',
];

export interface GarmentControlPoint {
  id: GarmentControlPointId;
  /** Normalized texture-space coordinates in [0,1], same convention as BodyFrame's Point2D. */
  u: number;
  v: number;
}

/**
 * Section 41: "one primary garment format... Only benchmark alternatives
 * when baseline fails." Grid is the only mesh type implemented; the
 * discriminated union exists so a future type can be added without
 * breaking the manifest schema version, not as license to add one
 * speculatively now.
 */
export type MeshDefinition = {
  type: 'grid';
  width: number;
  height: number;
};

export const KSGARMENT_SCHEMA_VERSION = '1.0' as const;

export interface KsgarmentManifest {
  version: typeof KSGARMENT_SCHEMA_VERSION;
  productId: string;
  category: GarmentCategory;
  subcategory: string | 'unknown';
  silhouette: string | 'unknown';
  sleeveLength: SleeveLength;
  garmentLength: GarmentLength;
  neckline: Neckline;
  controlPoints: GarmentControlPoint[];
  meshDefinition: MeshDefinition;
  texture: string;
  alphaMask: string;
  assetVersion: string;
}

export interface ManifestValidationIssue {
  field: string;
  message: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  issues: ManifestValidationIssue[];
}

/**
 * Hand-rolled runtime validation (no schema-validation dependency) —
 * Section 41 discipline applies to dependencies too: this manifest is
 * small and stable enough not to justify pulling in a validator library.
 * Used by the asset-pipeline QC stage (P1-D5) as the mechanical half of
 * "ACCEPTED / REJECTED".
 */
export function validateKsgarmentManifest(value: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  if (typeof value !== 'object' || value === null) {
    return { valid: false, issues: [{ field: '(root)', message: 'manifest must be a JSON object' }] };
  }
  const m = value as Record<string, unknown>;

  if (m.version !== KSGARMENT_SCHEMA_VERSION) {
    push('version', `expected "${KSGARMENT_SCHEMA_VERSION}", got ${JSON.stringify(m.version)}`);
  }
  if (typeof m.productId !== 'string' || m.productId.length === 0) {
    push('productId', 'required non-empty string');
  }
  if (typeof m.texture !== 'string' || m.texture.length === 0) {
    push('texture', 'required non-empty string (relative path)');
  }
  if (typeof m.alphaMask !== 'string' || m.alphaMask.length === 0) {
    push('alphaMask', 'required non-empty string (relative path)');
  }
  if (typeof m.assetVersion !== 'string' || m.assetVersion.length === 0) {
    push('assetVersion', 'required non-empty string');
  }

  const mesh = m.meshDefinition as Record<string, unknown> | undefined;
  if (!mesh || typeof mesh !== 'object') {
    push('meshDefinition', 'required object');
  } else {
    if (mesh.type !== 'grid') {
      push('meshDefinition.type', 'only "grid" is currently supported');
    }
    if (typeof mesh.width !== 'number' || mesh.width < 2) {
      push('meshDefinition.width', 'required number >= 2');
    }
    if (typeof mesh.height !== 'number' || mesh.height < 2) {
      push('meshDefinition.height', 'required number >= 2');
    }
  }

  const controlPoints = m.controlPoints;
  if (!Array.isArray(controlPoints)) {
    push('controlPoints', 'required array');
  } else {
    const seenIds = new Set<string>();
    controlPoints.forEach((cp, i) => {
      const point = cp as Record<string, unknown>;
      const id = point?.id;
      if (typeof id !== 'string' || !(GARMENT_CONTROL_POINT_IDS as readonly string[]).includes(id)) {
        push(`controlPoints[${i}].id`, `must be one of ${GARMENT_CONTROL_POINT_IDS.join(', ')}`);
      } else {
        seenIds.add(id);
      }
      if (typeof point?.u !== 'number' || point.u < 0 || point.u > 1) {
        push(`controlPoints[${i}].u`, 'must be a number in [0,1]');
      }
      if (typeof point?.v !== 'number' || point.v < 0 || point.v > 1) {
        push(`controlPoints[${i}].v`, 'must be a number in [0,1]');
      }
    });

    for (const required of MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT) {
      if (!seenIds.has(required)) {
        push('controlPoints', `missing required control point "${required}" (P1-E1 minimum for attachment)`);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
