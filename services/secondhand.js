import { supabase } from './supabaseClient';

const DEFAULT_LIMIT = 8;
const REQUEST_TIMEOUT_MS = 10000;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const listingUrl = cleanString(item.listingUrl);
      const title = cleanString(item.title);
      if (!listingUrl || !title) return null;
      return {
        id: cleanString(item.id) || `vinted-${index}`,
        title,
        price: cleanString(item.price),
        currency: cleanString(item.currency),
        imageUrl: cleanString(item.imageUrl),
        listingUrl,
        brand: cleanString(item.brand),
        size: cleanString(item.size),
        source: 'vinted',
      };
    })
    .filter(Boolean);
}

function emptyResponse(error = 'SECONDHAND_RESULTS_UNAVAILABLE', enabled = false, query = undefined) {
  return {
    enabled,
    items: [],
    error,
    meta: {
      resultCount: 0,
      query,
      source: 'vinted',
    },
  };
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Secondhand request timed out.')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function buildSecondhandSearchRequest(analysis) {
  const metadata = analysis?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;

  const category = cleanString(metadata.category);
  const color = cleanString(metadata.color);
  const brand = cleanString(metadata.brand);
  const size = cleanString(metadata.size);
  const itemType = cleanString(metadata.itemType || metadata.item_type);
  const style = cleanString(metadata.style);

  const query = [brand, color, itemType, category, style]
    .filter(Boolean)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join(' ');

  if (!query || query.length < 2) return null;

  return {
    query,
    category,
    color,
    brand,
    size,
    limit: DEFAULT_LIMIT,
  };
}

export async function searchVintedSecondhand(request) {
  const query = cleanString(request?.query);
  if (!query) return emptyResponse('INVALID_REQUEST', false);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[K-SCAN Secondhand] Supabase not configured; skipping resale search.');
    }
    return emptyResponse('SECONDHAND_RESULTS_UNAVAILABLE', false, query);
  }

  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('search-vinted-secondhand', {
        body: {
          ...request,
          query,
          limit: Number.isFinite(request?.limit) ? request.limit : DEFAULT_LIMIT,
        },
      }),
      REQUEST_TIMEOUT_MS,
    );

    if (error) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log('[K-SCAN Secondhand] Edge Function unavailable', error.message);
      }
      return emptyResponse('SECONDHAND_RESULTS_UNAVAILABLE', true, query);
    }

    return {
      enabled: Boolean(data?.enabled),
      items: cleanItems(data?.items),
      error: cleanString(data?.error) || undefined,
      meta: {
        resultCount: Array.isArray(data?.items) ? data.items.length : 0,
        query: cleanString(data?.meta?.query) || query,
        source: 'vinted',
      },
    };
  } catch (error) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[K-SCAN Secondhand] request failed', error?.message);
    }
    return emptyResponse('SECONDHAND_RESULTS_UNAVAILABLE', true, query);
  }
}
