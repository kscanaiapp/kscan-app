'use strict';

const { performance } = require('node:perf_hooks');
const { BudgetExceededError, COMMERCE_ONLY, classifyRequest } = require('./budget');
const { hashShort, sanitizeOffer, str } = require('./report');

const EDGE_FUNCTION = 'scan-identify';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const MAX_OFFERS_RECORDED = 10;

class LiveEdgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LiveEdgeError';
    this.code = code;
  }
}

/**
 * Staging only, asserted by exact project ref AND by URL. A loopback URL is allowed
 * solely for the offline dry run against the local mock edge, which holds no
 * credentials and spends nothing.
 */
function assertTarget({ baseUrl, projectRef, allowLoopback = false }) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new LiveEdgeError('base url is not a URL', 'BAD_URL');
  }
  if (allowLoopback && (host === '127.0.0.1' || host === 'localhost')) return { mode: 'loopback' };
  if (String(baseUrl).includes(PRODUCTION_PROJECT_REF) || projectRef === PRODUCTION_PROJECT_REF) {
    throw new LiveEdgeError('refusing to run against production', 'PRODUCTION');
  }
  if (projectRef !== STAGING_PROJECT_REF) {
    throw new LiveEdgeError(`project ref is not the staging project: ${projectRef}`, 'UNEXPECTED_REF');
  }
  if (host !== `${STAGING_PROJECT_REF}.supabase.co`) {
    throw new LiveEdgeError('url host is not the staging project host', 'UNEXPECTED_HOST');
  }
  return { mode: 'staging' };
}

function describeBody(body) {
  const requestMode = body?.requestMode ?? 'legacy_single_item';
  const candidate = body?.selectedCandidate?.candidateId ?? body?.candidateId ?? null;
  return {
    requestMode,
    candidateKey: candidate ? String(candidate).slice(0, 120) : null,
    imageDigestPrefix: typeof body?.imageDigestPrefix === 'string' ? body.imageDigestPrefix.slice(0, 16) : null,
    sessionHash: typeof body?.scanSessionId === 'string' ? hashShort(body.scanSessionId) : null,
    hasImage: typeof body?.imageBase64 === 'string' && body.imageBase64.length > 0,
    imageChars: typeof body?.imageBase64 === 'string' ? body.imageBase64.length : 0,
    // Deterministic fingerprint of the prepared bytes: binds a response to its source photo.
    imageKey: typeof body?.imageBase64 === 'string' && body.imageBase64 ? hashShort(body.imageBase64) : null,
    localPrivacyFiltered: body?.localPrivacyFiltered === true,
  };
}

function offersOf(data) {
  const raw = Array.isArray(data?.purchaseOptions)
    ? data.purchaseOptions
    : Array.isArray(data?.recommendedProducts) ? data.recommendedProducts : [];
  return raw;
}

/** Structured, bounded summary of what the server returned. No image bytes, no raw payload. */
function summarizeResponse(data) {
  if (!data || typeof data !== 'object') return null;
  const ident = data.identification && typeof data.identification === 'object' ? data.identification : null;
  const attrs = data.attributes && typeof data.attributes === 'object' ? data.attributes : null;
  const commerce = data.commerce && typeof data.commerce === 'object' ? data.commerce : null;
  const meta = data.shoppingMeta && typeof data.shoppingMeta === 'object' ? data.shoppingMeta : null;
  const funnel = data.funnel && typeof data.funnel === 'object' ? data.funnel : null;
  const offers = offersOf(data);
  return {
    status: str(data.status, 24),
    userMessage: str(data.userMessage, 120),
    candidateIdEcho: str(data.candidateId, 120),
    commerceDeferred: data.commerceDeferred === true || commerce?.deferred === true,
    detected: Array.isArray(data.detectedGarments)
      ? data.detectedGarments.slice(0, 8).map((g, index) => ({
        order: index,
        candidateId: str(g?.candidateId, 120),
        label: str(g?.label, 60),
        category: str(g?.category, 40),
        subtype: str(g?.subtype, 60),
        hasBounds: Boolean(g?.bounds),
        confidenceScore: typeof g?.confidenceScore === 'number' ? g.confidenceScore : null,
      }))
      : null,
    identification: ident
      ? {
        item_type: str(ident.item_type, 60),
        subtype: str(ident.subtype, 60),
        primary_color: str(ident.primary_color, 40),
        secondary_colors: Array.isArray(ident.secondary_colors) ? ident.secondary_colors.slice(0, 4).map((c) => str(c, 30)) : null,
        pattern: str(ident.pattern, 40),
        material_estimate: str(ident.material_estimate, 60),
        silhouette: str(ident.silhouette, 60),
        brand_guess: str(ident.brand_guess, 60),
        visible_brand_text: str(ident.visible_brand_text, 60),
        logo_detected: typeof ident.logo_detected === 'boolean' ? ident.logo_detected : null,
        confidence_score: typeof ident.confidence_score === 'number' ? ident.confidence_score : null,
        non_fashion: ident.non_fashion === true,
        scan_quality_note: str(ident.scan_quality_note, 100),
      }
      : null,
    attributes: attrs
      ? {
        category: str(attrs.category, 40),
        itemType: str(attrs.itemType, 60),
        colorPalette: Array.isArray(attrs.colorPalette) ? attrs.colorPalette.slice(0, 4).map((c) => str(c, 30)) : null,
        materialEstimate: str(attrs.materialEstimate, 60),
        pattern: str(attrs.pattern, 40),
        confidenceScore: typeof attrs.confidenceScore === 'number' ? attrs.confidenceScore : null,
      }
      : null,
    offerCount: offers.length,
    offers: offers.slice(0, MAX_OFFERS_RECORDED).map((o, i) => sanitizeOffer(o, i + 1)).filter(Boolean),
    commerce: commerce
      ? {
        provider: str(commerce.provider, 40),
        errorType: str(commerce.errorType, 40),
        available: typeof commerce.available === 'boolean' ? commerce.available : null,
        retryable: typeof commerce.retryable === 'boolean' ? commerce.retryable : null,
        count: typeof commerce.count === 'number' ? commerce.count : null,
        providersTried: Array.isArray(commerce.providersTried) ? commerce.providersTried.slice(0, 8).map((p) => str(p, 30)) : null,
      }
      : null,
    shoppingMeta: meta
      ? {
        provider: str(meta.provider, 40),
        count: typeof meta.count === 'number' ? meta.count : null,
        providersTried: Array.isArray(meta.providersTried) ? meta.providersTried.slice(0, 8).map((p) => str(p, 30)) : null,
        reason: str(meta.reason, 60),
      }
      : null,
    funnelCacheHit: funnel?.cacheHit === true,
    funnel: funnel
      ? {
        version: str(funnel.version, 12),
        discoveryMs: typeof funnel.discoveryMs === 'number' ? funnel.discoveryMs : null,
        earlyExit: typeof funnel.earlyExit === 'boolean' ? funnel.earlyExit : null,
        deadlineMs: typeof funnel.deadlineMs === 'number' ? funnel.deadlineMs : null,
      }
      : null,
  };
}

function createRecorder({ now = () => performance.now() } = {}) {
  const t0 = now();
  const entries = [];
  return {
    entries,
    now: () => now() - t0,
    record(entry) {
      const full = { seq: entries.length + 1, ...entry };
      entries.push(full);
      return full;
    },
  };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * A supabase-js-shaped `{ auth, functions }` whose `functions.invoke` performs a
 * real HTTPS request to `scan-identify` with the actor's bearer token, behind the
 * budget guard. It mirrors supabase-js's error contract so the REAL client
 * transport sees what it sees in the app:
 *   - network failure   -> { data: null, error: FunctionsFetchError }
 *   - non-2xx           -> { data: null, error: FunctionsHttpError(context = Response-like) }
 *   - caller abort      -> thrown AbortError
 */
function createLiveEdge({
  baseUrl,
  publishableKey,
  getToken,
  actor,
  actorId,
  budget,
  recorder,
  target,
  fetchImpl = fetch,
  hooks = {},
  phaseRef = { name: 'unphased' },
}) {
  if (!actor) throw new TypeError('actor label required');
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/functions/v1/${EDGE_FUNCTION}`;
  const requests = [];

  async function invoke(name, { body, signal } = {}) {
    if (name !== EDGE_FUNCTION) {
      recorder.record({ phase: phaseRef.name, actor, outcome: 'unexpected_function_refused', functionName: str(name, 60) });
      return { data: null, error: Object.assign(new Error('function not permitted by harness'), { name: 'FunctionsFetchError' }) };
    }
    if (signal?.aborted) throw abortError();

    const kind = classifyRequest(body);
    const meta = describeBody(body);
    const base = { phase: phaseRef.name, actor, kind, ...meta };
    const reqLog = { ...base, index: requests.length };
    requests.push(reqLog);

    // Zero-cost fault injection happens BEFORE the budget is reserved and before
    // anything is sent: an injected failure never reaches the provider.
    const injected = hooks.beforeSend ? await hooks.beforeSend({ ...base, seq: requests.length }) : null;
    if (injected?.fail) {
      recorder.record({ ...base, outcome: 'injected_network_error', latencyMs: 0 });
      reqLog.outcome = 'injected_network_error';
      return { data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' }) };
    }
    if (injected?.holdUntil) await injected.holdUntil;
    if (signal?.aborted) throw abortError();

    try {
      budget.reserve({ kind, actor });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        recorder.record({ ...base, outcome: 'budget_refused', refusal: error.detail?.reason ?? null });
        reqLog.outcome = 'budget_refused';
        return { data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' }) };
      }
      throw error;
    }

    const token = await getToken();
    const startedAt = performance.now();
    const startedAtRel = recorder.now();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          apikey: publishableKey ?? '',
          Authorization: `Bearer ${token ?? ''}`,
          'Content-Type': 'application/json',
          'x-client-info': 'kscan-scanner-live-certification',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      if (error?.name === 'AbortError') {
        recorder.record({ ...base, startedAtMs: Math.round(startedAtRel), latencyMs, outcome: 'aborted' });
        reqLog.outcome = 'aborted';
        throw error;
      }
      recorder.record({ ...base, startedAtMs: Math.round(startedAtRel), latencyMs, outcome: 'network_error' });
      reqLog.outcome = 'network_error';
      return { data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' }) };
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    const summary = summarizeResponse(parsed);
    const entry = recorder.record({
      ...base,
      startedAtMs: Math.round(startedAtRel),
      latencyMs,
      httpStatus: response.status,
      outcome: response.ok ? 'ok' : 'http_error',
      response: summary,
      // The raw id is a UUID (kept out of reports); its hash still correlates with server logs.
      requestHash: (() => { const raw = response.headers?.get?.('sb-request-id') ?? response.headers?.get?.('x-sb-request-id'); return raw ? hashShort(raw) : null; })(),
    });
    reqLog.outcome = entry.outcome;
    reqLog.seq = entry.seq;

    if (hooks.afterReceive) {
      await hooks.afterReceive({ ...base, seq: entry.seq, data: parsed, signal });
      if (signal?.aborted) throw abortError();
    }

    if (!response.ok) {
      const context = { status: response.status, json: async () => parsed };
      return {
        data: null,
        error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { name: 'FunctionsHttpError', context }),
      };
    }
    return { data: parsed, error: null };
  }

  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: actorId ?? 'actor-a' } } } }) },
    functions: { invoke },
  };

  return {
    supabase,
    requests,
    endpoint,
    target,
    get commerceOnlyCount() { return requests.filter((r) => r.kind === COMMERCE_ONLY && r.outcome !== 'injected_network_error' && r.outcome !== 'budget_refused').length; },
  };
}

module.exports = {
  EDGE_FUNCTION,
  LiveEdgeError,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  assertTarget,
  createLiveEdge,
  createRecorder,
  summarizeResponse,
};
