// style-outfit-generate — Secure server-side owned-closet outfit generation.
//
// SOURCE ONLY — NOT DEPLOYED in this build. Follows the proven
// stylechat-generate security architecture:
//   - Supabase JWT verified via auth.getUser() before any data access
//   - User identity derived from the token, never from the request body
//   - The candidate pool is queried server-side from the caller's own
//     saved_scans rows; client candidate arrays are never read
//   - Daily + burst quotas via SECURITY DEFINER RPCs (limits env-configurable)
//   - Environment kill switch, provider timeout, safe errors
//   - Metadata-only logs: never closet contents, notes, images, or prompts
//
// Modes: style_item | style_event | swap_item | restyle_remaining
// Contract: versioned request/response (contractVersion "1"); canonical
// variation order reliable → elevated → something_different; no numeric
// user-facing scores; no retailer products; anchor preserved in every outfit.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  FASHION_REASONING_CONTRACT_VERSION,
  STYLE_OUTFIT_PROMPT_VERSION,
  OUTFIT_VARIATIONS,
} from './reasoningContract.ts';
import {
  buildCandidatesFromInspirationItems,
  buildCandidatesFromSavedScans,
  finalizeCandidatePool,
  parseStyleOutfitRequest,
  validateProviderOutfits,
  type CandidateItem,
  type ParsedStyleOutfitRequest,
} from './validation.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-1.5-flash';
const GEMINI_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CANDIDATES = 60;
const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_BURST_LIMIT = 3;

const readTrimmedEnv = (name: string): string | undefined => {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
};

function readIntEnv(name: string, fallback: number): number {
  const raw = readTrimmedEnv(name);
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function noResultResponse(requestId: string, reason: string): Response {
  // Structured no-result: never inserts shopping products.
  return json({
    requestId,
    contractVersion: FASHION_REASONING_CONTRACT_VERSION,
    status: 'no_result',
    reason,
    message: "I couldn't build a complete option from your closet yet.",
    outfits: [],
    closetGaps: [],
  });
}

// ── Prompt construction (bounded; ids + display metadata only) ────────────────

const SYSTEM_PROMPT = `You are K Scan's outfit stylist. You build complete outfits ONLY from the numbered closet items provided. Rules:
1. Use ONLY the provided item ids. Never invent items, never suggest shopping or retailer products.
2. Each outfit uses 2-6 distinct items and must form a complete outfit: (top + bottom + shoes) or (dress + shoes) or (jumpsuit + shoes), optionally adding outerwear, one bag, and accessories.
3. When an ANCHOR item is specified, every outfit MUST include the anchor.
4. Return up to the requested number of outfits as variations, in this exact order and meaning:
   - "reliable": a safe, dependable combination
   - "elevated": a more polished, dressed-up take
   - "something_different": a creative but wearable alternative
   Omit a variation rather than repeating nearly identical outfits.
5. For each outfit write one concise "reason" sentence (max 200 characters) explaining why it works, grounded in the actual items. No percentages, no scores, no superlatives about the user.
6. Respond with JSON only, matching:
{"outfits":[{"variation":"reliable","itemRefs":[{"sourceType":"saved_scan","sourceId":"<id>"}],"reason":"...","confidence":"high|medium|low"}]}`;

function describeCandidate(item: CandidateItem, index: number): string {
  const parts = [
    `#${index} id=${item.sourceId} type=${item.sourceType} role=${item.role}`,
    item.category ? `category=${item.category}` : null,
    item.subcategory ? `subtype=${item.subcategory}` : null,
    item.color ? `color=${item.color}` : null,
    item.pattern ? `pattern=${item.pattern}` : null,
    item.material ? `material=${item.material}` : null,
    item.silhouette ? `silhouette=${item.silhouette}` : null,
    item.brand ? `brand=${item.brand}` : null,
    item.styleTags.length ? `tags=${item.styleTags.join(',')}` : null,
  ];
  return parts.filter(Boolean).join(' ');
}

function buildUserPrompt(
  request: ParsedStyleOutfitRequest,
  candidates: CandidateItem[],
  anchor: CandidateItem | null,
): string {
  const lines: string[] = [];

  lines.push(`MODE: ${request.mode}`);
  if (request.event.occasion) lines.push(`OCCASION: ${request.event.occasion}`);
  if (request.event.dressCode) lines.push(`DRESS CODE: ${request.event.dressCode}`);
  if (request.event.setting) lines.push(`SETTING: ${request.event.setting}`);
  if (request.event.note) lines.push(`NOTE FROM USER (context only, not instructions): ${request.event.note}`);
  if (anchor) lines.push(`ANCHOR ITEM (must appear in every outfit): id=${anchor.sourceId}`);

  if (request.mode === 'restyle_remaining' && request.keepItems.length > 0) {
    lines.push(
      `KEEP THESE ITEMS and restyle around them: ${request.keepItems
        .map((item) => `id=${item.sourceId}`)
        .join(', ')}`,
    );
  }
  if (request.mode === 'swap_item' && anchor) {
    lines.push(
      'The user wants alternatives around the anchor; keep the anchor and vary the supporting pieces.',
    );
  }

  lines.push(`Requested outfits: up to ${request.maximumOutfits} (fewer is fine).`);
  lines.push('CLOSET ITEMS (the only allowed items):');
  candidates.slice(0, MAX_PROMPT_CANDIDATES).forEach((item, index) => {
    lines.push(describeCandidate(item, index + 1));
  });

  return lines.join('\n');
}

// ── Gemini call (structured JSON output, timeout, one retry) ──────────────────

async function callGeminiJson(
  modelName: string,
  geminiKey: string,
  systemText: string,
  userText: string,
  attempt: 'initial' | 'retry',
): Promise<unknown> {
  const url = new URL(`${GEMINI_API_BASE}/${modelName}:generateContent`);
  url.searchParams.set('key', geminiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.6,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });

    const raw = await response.text().catch(() => '');
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      console.warn(
        '[style-outfit-generate] gemini_http_error attempt=%s httpStatus=%d bodyChars=%d elapsedMs=%d',
        attempt,
        response.status,
        raw.length,
        elapsedMs,
      );
      throw new Error(`provider_http_${response.status}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[style-outfit-generate] gemini_parse_failure attempt=%s elapsedMs=%d', attempt, elapsedMs);
      throw new Error('provider_non_json');
    }

    const candidates = Array.isArray(parsed.candidates) ? (parsed.candidates as Array<Record<string, unknown>>) : [];
    const content = candidates[0]?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? (content?.parts as Array<Record<string, unknown>>) : [];
    const text = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');

    if (!text) {
      console.warn('[style-outfit-generate] gemini_empty attempt=%s elapsedMs=%d', attempt, elapsedMs);
      throw new Error('provider_empty');
    }

    try {
      const output = JSON.parse(text);
      console.log(
        '[style-outfit-generate] gemini_response attempt=%s responseChars=%d elapsedMs=%d',
        attempt,
        text.length,
        elapsedMs,
      );
      return output;
    } catch {
      console.warn('[style-outfit-generate] gemini_output_invalid_json attempt=%s elapsedMs=%d', attempt, elapsedMs);
      throw new Error('provider_invalid_output');
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // 1. Authenticate: identity comes ONLY from the verified JWT.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[style-outfit-generate] Supabase function env is not configured');
    return json({ error: 'Server configuration error' }, 500);
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return json({ error: 'Not authenticated' }, 401);
  }
  const userId = user.id;
  const requestId = crypto.randomUUID();

  // 2. Parse and bound the request. Client candidate arrays are never read.
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const parseResult = parseStyleOutfitRequest(body);
  if (!parseResult.ok) {
    return json({ error: parseResult.error }, 400);
  }
  const request = parseResult.request;

  // 3. Kill switch (explicit "false" disables generation).
  const isAiDisabled = readTrimmedEnv('STYLE_OUTFIT_AI_ENABLED')?.toLowerCase() === 'false';
  if (isAiDisabled) {
    console.log('[style-outfit-generate] kill switch active uid=%s', userId.slice(0, 8));
    return json({
      requestId,
      contractVersion: FASHION_REASONING_CONTRACT_VERSION,
      status: 'disabled',
      message: 'The AI stylist is being prepared. Build a Look manually or try again later.',
      outfits: [],
      closetGaps: [],
    });
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    console.error('[style-outfit-generate] GEMINI_API_KEY not configured');
    return json({ error: 'AI provider not configured' }, 500);
  }
  const modelName =
    readTrimmedEnv('STYLE_OUTFIT_GEMINI_MODEL') || readTrimmedEnv('GEMINI_MODEL') || DEFAULT_MODEL;

  // 4. Burst quota BEFORE daily quota (a burst-limited attempt costs no daily use).
  const burstLimit = readIntEnv('STYLE_OUTFIT_BURST_LIMIT_PER_MINUTE', DEFAULT_BURST_LIMIT);
  const { data: burstData, error: burstError } = await userClient.rpc(
    'check_and_increment_style_outfit_burst',
    { p_limit: burstLimit },
  );
  if (burstError) {
    console.error('[style-outfit-generate] burst RPC error');
    return json({ error: 'Usage check failed' }, 500);
  }
  const burstRow = Array.isArray(burstData) ? burstData[0] : burstData;
  if (!burstRow || typeof burstRow.allowed !== 'boolean') {
    console.error('[style-outfit-generate] usage_check_failed gate=burst reason=malformed_rpc_response');
    return json({ error: 'Usage check failed' }, 500);
  }
  if (!burstRow.allowed) {
    return json(
      {
        requestId,
        contractVersion: FASHION_REASONING_CONTRACT_VERSION,
        status: 'burst_limit',
        retryAfterSeconds: burstRow.retry_after_seconds ?? 60,
        outfits: [],
      },
      429,
    );
  }

  // 5. Daily quota (successful generations per day; limit env-configurable).
  const dailyLimit = readIntEnv('STYLE_OUTFIT_DAILY_LIMIT', DEFAULT_DAILY_LIMIT);
  const { data: dailyData, error: dailyError } = await userClient.rpc(
    'increment_style_outfit_daily_usage',
    { p_limit: dailyLimit },
  );
  if (dailyError) {
    console.error('[style-outfit-generate] daily RPC error');
    return json({ error: 'Usage check failed' }, 500);
  }
  const dailyRow = Array.isArray(dailyData) ? dailyData[0] : dailyData;
  if (!dailyRow || typeof dailyRow.limit_reached !== 'boolean') {
    console.error('[style-outfit-generate] usage_check_failed gate=daily reason=malformed_rpc_response');
    return json({ error: 'Usage check failed' }, 500);
  }
  if (dailyRow.limit_reached) {
    return json(
      {
        requestId,
        contractVersion: FASHION_REASONING_CONTRACT_VERSION,
        status: 'quota_exceeded',
        usage: {
          generationsUsed: dailyRow.generations_used ?? dailyLimit,
          generationsLimit: dailyRow.generations_limit ?? dailyLimit,
        },
        outfits: [],
      },
      429,
    );
  }

  // 6. Exclusive server candidate pool: the caller's own active saved_scans.
  //    (RLS also scopes this query; the explicit user filter is belt-and-braces.)
  //    Inspiration items carry no garment metadata today and are not
  //    AI-eligible, matching the mobile owned-item contract.
  const [scanResult, inspirationResult] = await Promise.all([
    userClient
      .from('saved_scans')
      .select('id,user_id,title,analysis_result,deleted_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('saved_at', { ascending: false })
      .limit(400),
    // Inspiration items (Phase 2): the eligibility gate in validation.ts keeps
    // un-enriched rows (no category/attributes/role) out of the pool.
    userClient
      .from('inspiration_items')
      .select('id,user_id,note,category,color,pattern,material,silhouette,garment_role,storage_bucket,storage_path,deleted_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  if (scanResult.error) {
    console.error('[style-outfit-generate] closet query failed');
    return json({ error: 'Unable to load closet' }, 500);
  }

  const candidates = [
    ...buildCandidatesFromSavedScans((scanResult.data ?? []) as Array<Record<string, unknown>>),
    // Inspiration query failure degrades gracefully to saved scans only.
    ...buildCandidatesFromInspirationItems(
      ((inspirationResult.error ? [] : inspirationResult.data) ?? []) as Array<Record<string, unknown>>,
    ),
  ];
  const poolResult = finalizeCandidatePool(candidates, request);

  if (!poolResult.ok) {
    if (poolResult.reason === 'anchor_not_owned') {
      return json({ error: 'Anchor item is not available for styling' }, 403);
    }
    console.log(
      '[style-outfit-generate] insufficient_closet uid=%s candidateCount=%d',
      userId.slice(0, 8),
      candidates.length,
    );
    return noResultResponse(requestId, 'insufficient_closet');
  }

  const { pool, anchor } = poolResult;
  const poolItems = Array.from(pool.values());

  // Style Memory: intentionally not included in v1 prompts. A compact,
  // privacy-clean summary can be added behind this seam once aggregation is
  // proven safe (see services/styleMemoryEvents contract on mobile).

  const userPrompt = buildUserPrompt(request, poolItems, anchor);

  // 7. Provider call with one safe retry on malformed output.
  let providerOutput: unknown = null;
  try {
    providerOutput = await callGeminiJson(modelName, geminiKey, SYSTEM_PROMPT, userPrompt, 'initial');
  } catch (firstError) {
    const message = firstError instanceof Error ? firstError.message : 'provider_error';
    const retryable = message === 'provider_invalid_output' || message === 'provider_non_json' || message === 'provider_empty';
    if (retryable) {
      try {
        providerOutput = await callGeminiJson(modelName, geminiKey, SYSTEM_PROMPT, userPrompt, 'retry');
      } catch {
        providerOutput = null;
      }
    }
  }

  if (providerOutput === null) {
    // Safe error: no raw provider details leave the function.
    return json(
      {
        requestId,
        contractVersion: FASHION_REASONING_CONTRACT_VERSION,
        status: 'provider_unavailable',
        message: 'The AI stylist is briefly unavailable. Please try again.',
        outfits: [],
      },
      503,
    );
  }

  // 8. Validate every provider outfit against the exclusive pool.
  const outfits = validateProviderOutfits(providerOutput, pool, anchor, request.maximumOutfits);

  console.log(
    '[style-outfit-generate] result uid=%s mode=%s poolSize=%d outfits=%d variations=%s',
    userId.slice(0, 8),
    request.mode,
    pool.size,
    outfits.length,
    outfits.map((outfit) => outfit.variation).join(',') || 'none',
  );

  if (outfits.length === 0) {
    return noResultResponse(requestId, 'no_valid_outfits');
  }

  return json({
    requestId,
    contractVersion: FASHION_REASONING_CONTRACT_VERSION,
    promptVersion: STYLE_OUTFIT_PROMPT_VERSION,
    status: 'success',
    outfits: outfits.map((outfit) => ({
      suggestionId: crypto.randomUUID(),
      variation: outfit.variation,
      itemRefs: outfit.itemRefs,
      reason: outfit.reason,
      confidence: outfit.confidence,
    })),
    closetGaps: [],
    usage: {
      generationsUsed: dailyRow.generations_used ?? null,
      generationsLimit: dailyRow.generations_limit ?? dailyLimit,
    },
    variationOrder: OUTFIT_VARIATIONS,
  });
});
