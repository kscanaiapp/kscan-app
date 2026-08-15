import type { ScanImageSnapshotSource } from '../types/styleObjects';

export type DressingRoomScanSnapshotMetadata = {
  category: string | null;
  subcategory: string | null;
  color: string | null;
  colors: string[];
  materials: string[];
  material: string | null;
  silhouette: string | null;
  pattern: string | null;
  fit: string | null;
  itemType: string | null;
  brand: string | null;
  brandEvidence: Array<{
    type: string;
    value: string | null;
    confidence: number | null;
  }>;
  size: string | null;
  capturedAt: string | null;
};

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function textList(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = text(entry);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function brandEvidence(value: unknown): DressingRoomScanSnapshotMetadata['brandEvidence'] {
  if (!Array.isArray(value)) return [];
  const out: DressingRoomScanSnapshotMetadata['brandEvidence'] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = text(record.type);
    if (!type) continue;
    out.push({
      type,
      value: text(record.value),
      confidence:
        typeof record.confidence === 'number' && Number.isFinite(record.confidence)
          ? record.confidence
          : null,
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Bounded metadata persisted with a Scanner-originated Dressing Room item.
 * Brand evidence remains an array of typed claims; this function never derives
 * the scalar brand from brand_guess.
 */
export function buildDressingRoomScanSnapshotMetadata(
  metadata: NonNullable<ScanImageSnapshotSource['metadata']> | null | undefined,
  capturedAt?: string | null,
): DressingRoomScanSnapshotMetadata {
  const input = metadata ?? {};
  const primaryColor = text(input.color);
  const secondaryColors = textList(input.secondaryColors).filter(
    (color) => color !== primaryColor,
  );
  const materials = textList(input.materials);
  const primaryMaterial = text(input.material) ?? materials[0] ?? null;
  if (primaryMaterial && !materials.includes(primaryMaterial)) materials.unshift(primaryMaterial);

  return {
    category: text(input.category),
    subcategory: text(input.subcategory) ?? text(input.itemType),
    color: primaryColor,
    colors: primaryColor ? [primaryColor, ...secondaryColors] : secondaryColors,
    materials,
    material: primaryMaterial,
    silhouette: text(input.silhouette),
    pattern: text(input.pattern),
    fit: text(input.fit),
    itemType: text(input.itemType),
    brand: text(input.brand),
    brandEvidence: brandEvidence(input.brandEvidence),
    size: text(input.size),
    capturedAt: text(capturedAt),
  };
}
