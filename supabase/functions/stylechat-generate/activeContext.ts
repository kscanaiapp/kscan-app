// ── Active scan/upload/TextScan context (StyleChat grounding) ─────────────────
// Pure helpers, no Deno/network imports, so they are unit-testable from node too.
//
// Backward-compatibility contract:
//   - activeContext is fully optional. Absent -> null -> prompt unchanged (old apps).
//   - Malformed / unknown source -> null (silent no-op). Never throws.
//   - Only compact, fashion-only fields are emitted. Local image URIs and ids are
//     intentionally dropped; they are not useful to the model and may contain PII.

export type ActiveContextSource = 'camera' | 'upload' | 'text-scan';

export interface ActiveContextVisualContext {
  source: 'scan' | 'upload';
  title: string;
  summary?: string | null;
  category?: string | null;
  colors?: string[] | null;
  materials?: string[] | null;
  silhouette?: string | null;
  styleAttributes?: string[] | null;
  brand?: string | null;
  confidence?: number | null;
}

export interface ActiveContextInput {
  source: ActiveContextSource;
  query?: string | null;
  category?: string | null;
  color?: string | null;
  silhouette?: string | null;
  material?: string | null;
  descriptors?: string[] | null;
  analysisText?: string | null;
  visualContext?: ActiveContextVisualContext | null;
}

const VALID_SOURCES: ActiveContextSource[] = ['camera', 'upload', 'text-scan'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0);
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!isStringArray(value)) return null;
  const trimmed = value.map((s) => s.trim()).filter((s) => s.length > 0);
  return trimmed.length ? trimmed : null;
}

export function parseActiveContext(raw: unknown): ActiveContextInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const source = typeof r.source === 'string' ? r.source : '';
  if (!VALID_SOURCES.includes(source as ActiveContextSource)) return null;

  const descriptors = Array.isArray(r.descriptors)
    ? (r.descriptors as unknown[])
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => d.trim())
    : null;

  const visualRaw = r.visualContext;
  let visualContext: ActiveContextVisualContext | null = null;
  if (visualRaw && typeof visualRaw === 'object' && !Array.isArray(visualRaw)) {
    const v = visualRaw as Record<string, unknown>;
    const rawSource = v.source === 'scan' || v.source === 'upload' ? v.source : source;
    const vcSource: 'scan' | 'upload' = rawSource === 'scan' || rawSource === 'upload' ? rawSource : 'upload';
    const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : '';
    if (title) {
      visualContext = {
        source: vcSource,
        title,
        summary: typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim() : null,
        category: typeof v.category === 'string' && v.category.trim() ? v.category.trim() : null,
        colors: normalizeStringArray(v.colors),
        materials: normalizeStringArray(v.materials),
        silhouette: typeof v.silhouette === 'string' && v.silhouette.trim() ? v.silhouette.trim() : null,
        styleAttributes: normalizeStringArray(v.styleAttributes),
        brand: typeof v.brand === 'string' && v.brand.trim() ? v.brand.trim() : null,
        confidence: typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? v.confidence : null,
      };
    }
  }

  return {
    source: source as ActiveContextSource,
    query: typeof r.query === 'string' && r.query.trim() ? r.query.trim() : null,
    category: typeof r.category === 'string' && r.category.trim() ? r.category.trim() : null,
    color: typeof r.color === 'string' && r.color.trim() ? r.color.trim() : null,
    silhouette: typeof r.silhouette === 'string' && r.silhouette.trim() ? r.silhouette.trim() : null,
    material: typeof r.material === 'string' && r.material.trim() ? r.material.trim() : null,
    descriptors: descriptors?.length ? descriptors : null,
    analysisText: typeof r.analysisText === 'string' && r.analysisText.trim() ? r.analysisText.trim() : null,
    visualContext,
  };
}

function sourceLabel(source: ActiveContextSource): string {
  if (source === 'camera') return 'Scan';
  if (source === 'upload') return 'Upload';
  return 'TextScan';
}

function renderVisualContext(vc: ActiveContextVisualContext): string {
  const lines: string[] = [];
  lines.push(`Item: ${vc.title}`);
  if (vc.summary) lines.push(`Description: ${vc.summary}`);
  const attrs: string[] = [];
  if (vc.category) attrs.push(vc.category);
  if (vc.colors?.length) attrs.push(...vc.colors);
  if (vc.materials?.length) attrs.push(...vc.materials);
  if (vc.silhouette) attrs.push(vc.silhouette);
  if (vc.styleAttributes?.length) attrs.push(...vc.styleAttributes);
  if (vc.brand) attrs.push(vc.brand);
  if (attrs.length) lines.push(`Attributes: ${attrs.join(', ')}`);
  if (typeof vc.confidence === 'number') {
    lines.push(`Confidence: ${Math.round(vc.confidence * 100)}%`);
  }
  return lines.join('\n');
}

export function buildActiveContextBlock(ctx: ActiveContextInput): string {
  const lines: string[] = [];
  lines.push(`Source: ${sourceLabel(ctx.source)}`);

  if (ctx.visualContext) {
    lines.push('');
    lines.push(renderVisualContext(ctx.visualContext));
  }

  const description = ctx.query ?? ctx.analysisText ?? null;
  if (description) {
    lines.push(`Description: ${description}`);
  }

  const attrs: string[] = [];
  if (ctx.category) attrs.push(ctx.category);
  if (ctx.color) attrs.push(ctx.color);
  if (ctx.silhouette) attrs.push(ctx.silhouette);
  if (ctx.material) attrs.push(ctx.material);
  if (ctx.descriptors?.length) attrs.push(...ctx.descriptors);

  if (attrs.length) {
    lines.push(`Attributes: ${attrs.join(', ')}`);
  }

  return [
    '[Active Reference Item]',
    ...lines,
    '[/Active Reference Item]',
    '',
    'Instruction: Use the Active Reference Item above as the current subject. Do not substitute a different item. If the user describes the item differently than the Active Reference Item, politely clarify the mismatch before giving advice.',
    'For purchase, "where can I buy", or "find similar" questions, give a grounded search phrase built from the Active Reference Item attributes, then suggest 2-4 related search terms. Do not invent exact product URLs, prices, stock, or retailer availability unless explicitly provided.',
  ].join('\n');
}
