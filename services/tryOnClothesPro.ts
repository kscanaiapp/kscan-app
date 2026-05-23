// Try-On Clothes Pro client service.
// All RapidAPI calls are made server-side by the `tryon-clothes-pro`
// Supabase Edge Function.  No API key is present here or in the client bundle.

import { supabase } from './supabaseClient';

const EDGE_FN        = 'tryon-clothes-pro';
const INVOKE_TIMEOUT = 25_000; // slightly longer than the edge fn's 20 s upstream timeout

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TryOnRequest {
  person_image:   string;
  top_garment?:    string;
  bottom_garment?: string;
  resolution?:     string;
  restore_face?:   boolean;
}

export interface TryOnResult {
  source:   'tryon_clothes_pro';
  status:   string | null;
  imageUrl: string | null;
  taskId:   string | null;
  raw:      unknown;
}

// ─── Response normalizer ──────────────────────────────────────────────────────

function normalizeResult(data: Record<string, unknown>): TryOnResult {
  // Common field patterns across RapidAPI image-generation responses
  const imageUrl =
    (data.image_url      as string | undefined) ??
    (data.imageUrl       as string | undefined) ??
    (data.result_url     as string | undefined) ??
    (data.output_url     as string | undefined) ??
    (data.output         as string | undefined) ??
    (Array.isArray(data.images) ? (data.images[0] as string | undefined) : undefined) ??
    null;

  const taskId =
    (data.task_id        as string | undefined) ??
    (data.taskId         as string | undefined) ??
    (data.id             as string | undefined) ??
    null;

  const status =
    (data.status         as string | undefined) ??
    (data.state          as string | undefined) ??
    (data.code !== undefined ? String(data.code) : undefined) ??
    null;

  return {
    source:   'tryon_clothes_pro',
    status,
    imageUrl: typeof imageUrl === 'string' ? imageUrl : null,
    taskId:   typeof taskId  === 'string' ? taskId  : null,
    raw:      data,
  };
}

// ─── Client function ──────────────────────────────────────────────────────────

export async function requestTryOn(request: TryOnRequest): Promise<TryOnResult | null> {
  const { person_image, top_garment, bottom_garment, resolution, restore_face } = request;

  if (!person_image || typeof person_image !== 'string') return null;
  if (!top_garment && !bottom_garment) return null;

  const ac        = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT);

  try {
    const body: Record<string, unknown> = { person_image };
    if (top_garment)              body.top_garment    = top_garment;
    if (bottom_garment)           body.bottom_garment = bottom_garment;
    if (resolution !== undefined) body.resolution     = resolution;
    if (restore_face !== undefined) body.restore_face = restore_face;

    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body,
      signal: ac.signal,
    });

    if (error) {
      if (__DEV__) console.warn('[tryOnClothesPro] invoke error:', error?.message);
      return null;
    }

    if (!data || typeof data !== 'object' || (data as Record<string, unknown>).error) {
      if (__DEV__) {
        const edgeErr = (data as Record<string, unknown> | null)?.error;
        if (edgeErr) console.warn('[tryOnClothesPro] edge error:', edgeErr);
      }
      return null;
    }

    return normalizeResult(data as Record<string, unknown>);

  } catch (err: any) {
    if (__DEV__) {
      const isAbort = err?.name === 'AbortError';
      console.warn('[tryOnClothesPro]', isAbort ? 'invoke timed out' : err?.message);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
