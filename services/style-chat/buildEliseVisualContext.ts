import type {
  EliseVisualContext,
  EliseVisualContextSource,
  EliseVisualContextStatus,
} from '../../types/eliseVisualContext';
import type { ScanIdentifyResponse } from '../../types/scanIdentification';

let idCounter = 0;

export type BuildEliseVisualContextInput = {
  source: EliseVisualContextSource;
  sessionId: string;
  actorKey: string;
  status: EliseVisualContextStatus;
  title: string;
  summary?: string;
  category?: string;
  colors?: string[];
  materials?: string[];
  silhouette?: string;
  styleAttributes?: string[];
  brand?: string;
  confidence?: number;
  savedScanId?: string;
  sanitizedPreviewUri?: string;
  privacyPolicy?: EliseVisualContext['privacyPolicy'];
  revision?: number;
};

export function buildEliseVisualContext(input: BuildEliseVisualContextInput): EliseVisualContext {
  return {
    id: `elise-vc-${Date.now()}-${++idCounter}`,
    actorKey: input.actorKey,
    sessionId: input.sessionId,
    source: input.source,
    status: input.status,
    title: input.title,
    summary: input.summary,
    category: input.category,
    colors: input.colors,
    materials: input.materials,
    silhouette: input.silhouette,
    styleAttributes: input.styleAttributes,
    brand: input.brand,
    confidence: input.confidence,
    savedScanId: input.savedScanId,
    sanitizedPreviewUri: input.sanitizedPreviewUri,
    privacyPolicy: input.privacyPolicy,
    createdAt: Date.now(),
    revision: input.revision ?? 0,
  };
}

/**
 * Build a ready visual context from a normalized scan-identify response.
 * Never fabricates fields: only evidence provided by the response is used.
 */
export function buildEliseVisualContextFromScanIdentify(
  response: ScanIdentifyResponse,
  input: Omit<BuildEliseVisualContextInput, 'status' | 'title' | 'summary' | 'category' | 'colors' | 'materials' | 'silhouette' | 'styleAttributes' | 'brand' | 'confidence'>,
): EliseVisualContext {
  const id = response.identification;
  const attr = response.attributes;

  const category = id?.item_type ?? attr?.category ?? '';

  const colors: string[] = [];
  if (id?.primary_color) colors.push(id.primary_color);
  if (Array.isArray(id?.secondary_colors) && id.secondary_colors.length) {
    colors.push(...id.secondary_colors);
  }
  if (!colors.length && Array.isArray(attr?.colorPalette) && attr.colorPalette.length) {
    colors.push(...attr.colorPalette);
  }

  const styleAttributes = Array.isArray(id?.style_tags) && id.style_tags.length
    ? id.style_tags
    : Array.isArray(attr?.styleTags) && attr.styleTags.length
      ? attr.styleTags
      : undefined;

  const title =
    response.displayResult?.headline?.trim() ||
    id?.visual_observation?.trim() ||
    (category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Fashion item');

  const summary =
    response.displayResult?.details?.trim() ||
    id?.visual_observation?.trim() ||
    response.userMessage?.trim();

  const brand = id?.brand_guess ?? id?.visible_brand_text ?? undefined;
  const confidence = id?.confidence_score ?? attr?.confidenceScore ?? undefined;

  return buildEliseVisualContext({
    ...input,
    status: 'ready',
    title,
    summary,
    category,
    colors: colors.length ? colors : undefined,
    materials: id?.material_estimate ? [id.material_estimate] : undefined,
    silhouette: id?.silhouette ?? attr?.silhouette ?? undefined,
    styleAttributes,
    brand,
    confidence,
  });
}
