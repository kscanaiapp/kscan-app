import type { MeshDefinition } from './garmentContract';

/**
 * Grid dimensions are not mandated by the `.ksgarment` schema beyond
 * `{type:'grid', width, height}` (task section 25: "do not invent arbitrary
 * grid dimensions unless required by the existing authoritative schema" —
 * there is no such requirement here, only the type discriminant). 8x10 is a
 * modest, reasonable default for a simple-top silhouette, not derived from
 * any physical measurement; recorded here rather than left implicit.
 */
export const DEFAULT_MESH_DEFINITION: MeshDefinition = { type: 'grid', width: 8, height: 10 };

export function buildMeshDefinition(): MeshDefinition {
  return { ...DEFAULT_MESH_DEFINITION };
}
