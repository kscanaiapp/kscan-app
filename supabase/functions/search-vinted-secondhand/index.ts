const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type VintedSecondhandErrorCode =
  | 'SECONDHAND_RESULTS_UNAVAILABLE'
  | 'FEATURE_DISABLED'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_SCHEMA_UNEXPECTED';

type SearchRequest = {
  query: string;
  category?: string | null;
  color?: string | null;
  brand?: string | null;
  size?: string | null;
  limit?: number;
};

type SecondhandItem = {
  id: string;
  title: string;
  price?: string;
  currency?: string;
  imageUrl?: string;
  listingUrl: string;
  brand?: string;
  size?: string;
  source: 'vinted';
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function cleanString(value: unknown, maxLength = 120) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function response(
  enabled: boolean,
  items: SecondhandItem[],
  query?: string,
  error?: VintedSecondhandErrorCode,
) {
  return {
    enabled,
    items,
    error,
    meta: {
      resultCount: items.length,
      query,
      source: 'vinted',
    },
  };
}

function isEnabled() {
  return Deno.env.get('SECONDHAND_VINTED_ENABLED')?.toLowerCase() !== 'false';
}

function parseRequest(raw: unknown): SearchRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const query = cleanString(body.query);
  if (!query || query.length < 2) return null;

  const rawLimit = Number(body.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 12)
    : 8;

  return {
    query,
    category: cleanString(body.category),
    color: cleanString(body.color),
    brand: cleanString(body.brand),
    size: cleanString(body.size),
    limit,
  };
}

function buildActorInput(request: SearchRequest) {
  const template = Deno.env.get('APIFY_VINTED_INPUT_TEMPLATE');
  if (template) {
    try {
      return {
        ...JSON.parse(template),
        query: request.query,
        search: request.query,
        searchText: request.query,
        maxItems: request.limit,
        limit: request.limit,
      };
    } catch {
      console.warn('[search-vinted-secondhand] APIFY_VINTED_INPUT_TEMPLATE is invalid JSON');
    }
  }

  return {
    query: request.query,
    search: request.query,
    searchText: request.query,
    maxItems: request.limit,
    limit: request.limit,
    filters: {
      category: request.category,
      color: request.color,
      brand: request.brand,
      size: request.size,
    },
  };
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value, 300);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function firstNestedString(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const cleaned = firstString(record[key]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function imageFrom(raw: Record<string, unknown>) {
  const direct = firstString(raw.imageUrl, raw.image_url, raw.image, raw.photoUrl, raw.photo_url, raw.thumbnail);
  if (direct) return direct;

  const photo = firstNestedString(raw.photo, ['url', 'full_size_url', 'src']);
  if (photo) return photo;

  const images = raw.images ?? raw.photos;
  if (Array.isArray(images)) {
    for (const image of images) {
      const fromObject = firstNestedString(image, ['url', 'full_size_url', 'src']);
      if (fromObject) return fromObject;
      const fromString = firstString(image);
      if (fromString) return fromString;
    }
  }

  return undefined;
}

function normalizeUrl(value: unknown) {
  const url = firstString(value, 500);
  if (!url) return undefined;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `https://www.vinted.com${url}`;
  return undefined;
}

function normalizeItems(raw: unknown[], limit: number): SecondhandItem[] {
  return raw
    .map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const listingUrl = normalizeUrl(
        record.listingUrl ?? record.listing_url ?? record.itemUrl ?? record.url ?? record.web_url,
      );
      const title = firstString(record.title, record.name, record.description);
      if (!listingUrl || !title) return null;

      return {
        id: firstString(record.id, record.itemId, record.item_id) ?? `vinted-${index}`,
        title,
        price: firstString(record.price, record.total_item_price, record.amount),
        currency: firstString(record.currency, record.currencyCode, record.currency_code),
        imageUrl: imageFrom(record),
        listingUrl,
        brand: firstString(record.brand, record.brandTitle, record.brand_title),
        size: firstString(record.size, record.sizeTitle, record.size_title),
        source: 'vinted' as const,
      };
    })
    .filter((item): item is SecondhandItem => Boolean(item))
    .slice(0, limit);
}

async function runApify(request: SearchRequest) {
  const actorId = Deno.env.get('APIFY_VINTED_ACTOR_ID');
  const token = Deno.env.get('APIFY_API_TOKEN');
  if (!actorId || !token) {
    console.warn('[search-vinted-secondhand] Missing Apify configuration');
    return { items: [], error: 'SECONDHAND_RESULTS_UNAVAILABLE' as const };
  }

  const timeoutSecs = Math.min(Math.max(Number(Deno.env.get('APIFY_VINTED_TIMEOUT_SECS')) || 20, 5), 30);
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?timeout=${timeoutSecs}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSecs * 1000 + 1500);
  const startedAt = Date.now();

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildActorInput(request)),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;

    if (!upstream.ok) {
      console.warn('[search-vinted-secondhand] Apify failure', JSON.stringify({
        status: upstream.status,
        elapsedMs,
      }));
      return { items: [], error: 'SECONDHAND_RESULTS_UNAVAILABLE' as const };
    }

    const raw = await upstream.json().catch(() => null);
    if (!Array.isArray(raw)) {
      console.warn('[search-vinted-secondhand] Unexpected Apify schema', JSON.stringify({
        elapsedMs,
        schema: raw && typeof raw,
      }));
      return { items: [], error: 'UPSTREAM_SCHEMA_UNEXPECTED' as const };
    }

    const items = normalizeItems(raw, request.limit ?? 8);
    console.log('[search-vinted-secondhand] success', JSON.stringify({
      elapsedMs,
      rawCount: raw.length,
      resultCount: items.length,
    }));
    return { items };
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError';
    console.warn('[search-vinted-secondhand] Apify exception', JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      items: [],
      error: isTimeout ? 'UPSTREAM_TIMEOUT' as const : 'SECONDHAND_RESULTS_UNAVAILABLE' as const,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  {
    const { assertAccountActiveIfAuthenticated } = await import(
      '../_shared/deletion/assertAccountActiveIfAuthenticated.ts'
    );
    const blocked = await assertAccountActiveIfAuthenticated(req);
    if (blocked) return blocked;
  }

  if (!isEnabled()) {
    return json(response(false, [], undefined, 'FEATURE_DISABLED'));
  }

  const body = await req.json().catch(() => null);
  const request = parseRequest(body);
  if (!request) {
    return json(response(true, [], undefined, 'INVALID_REQUEST'), 400);
  }

  const result = await runApify(request);
  return json(response(true, result.items, request.query, result.error));
});
