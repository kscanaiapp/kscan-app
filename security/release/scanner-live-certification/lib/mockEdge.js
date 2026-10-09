'use strict';

/**
 * LOCAL MOCK of the scan-identify wire contract. It exists ONLY to prove the
 * harness mechanics offline at zero cost (dry run and unit tests). Nothing it
 * returns is evidence about the real function, and the live runner refuses to run
 * against it unless explicitly told it is a loopback dry run.
 *
 * It re-implements just enough of the server's observable validation that a
 * harness bug (wrong header, image bytes on MODE B, a lost correlation id) is
 * caught here instead of costing a paid request: bearer required, MODE B rejects
 * image-shaped keys, selected_item requires the server-issued session + digest +
 * a candidate that the detection call actually returned, and `candidateId` is
 * echoed through a 120-character `safeString` exactly like the real handler.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_STRING_LEN = 120;
const PROHIBITED_IMAGE_KEYS = ['imageBase64', 'image', 'imageUrl', 'imageUri', 'photo', 'base64', 'evidence'];

const safeString = (value) => {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_STRING_LEN) : undefined;
};

const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'garment';
const digest = (b64) => crypto.createHash('sha256').update(String(b64)).digest('hex');

function containsImageKey(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 4) return null;
  for (const [key, value] of Object.entries(body)) {
    if (PROHIBITED_IMAGE_KEYS.includes(key) && value !== undefined && value !== null) return key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = containsImageKey(value, depth + 1);
      if (nested) return `${key}.${nested}`;
    }
  }
  return null;
}

function createMockEdge({ corpus, token = 'dry-token', latency = {}, offerFactory } = {}) {
  const known = new Map(); // sha256(imageBase64) -> corpus image
  const sessions = new Map(); // scanSessionId -> { image, candidates }
  const counters = { detection: 0, selected: 0, commerce: 0, rejected: 0 };
  const log = [];
  let failNext = null;

  const wait = (kind) => new Promise((resolve) => setTimeout(resolve, latency[kind] ?? 0));

  function defaultOffers(garment, n = 8) {
    const base = (garment.offerTitleAny ?? ['item'])[0];
    return Array.from({ length: n }, (_, i) => ({
      title: `${['Classic', 'Modern', 'Vintage', 'Premium'][i % 4]} ${base} ${i + 1}`,
      retailer: ['Shop A', 'Shop B', 'Shop C'][i % 3],
      provider: 'serper',
      price: 20 + i * 5,
      currency: 'USD',
      productUrl: `https://shop${(i % 3) + 1}.example.com/p/${slug(base)}-${i + 1}?utm=x`,
    }));
  }

  async function handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'sb-request-id': crypto.randomUUID() });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST' || !req.url.endsWith('/functions/v1/scan-identify')) return send(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${token}`) { counters.rejected += 1; return send(401, { error: 'Not authenticated' }); }
    let body;
    try { body = JSON.parse(raw); } catch { counters.rejected += 1; return send(400, { error: 'bad json' }); }

    if (failNext) {
      const fail = failNext;
      failNext = null;
      if (fail.status) return send(fail.status, fail.payload ?? { error: 'forced' });
    }

    // ── MODE B ────────────────────────────────────────────────────────────
    if (body.requestMode === 'commerce_only') {
      const bad = containsImageKey(body);
      if (bad) { counters.rejected += 1; return send(400, { error: `image_payload_rejected:${bad}` }); }
      counters.commerce += 1;
      await wait('commerce');
      const ident = body.identification ?? {};
      const garment = [...known.values()].flatMap((img) => img.expectedGarments ?? [])
        .find((g) => (g.subtypeAny ?? []).some((t) => String(ident.subtype ?? ident.item_type ?? '').toLowerCase().includes(t)))
        ?? { offerTitleAny: [ident.item_type ?? 'item'] };
      const offers = (offerFactory ?? defaultOffers)(garment, ident.__noOffers ? 0 : 8);
      log.push({ kind: 'commerce', candidateId: safeString(body.candidateId) ?? null });
      return send(200, {
        status: 'completed',
        purchaseOptions: offers,
        recommendedProducts: offers,
        ...(safeString(body.candidateId) ? { candidateId: safeString(body.candidateId) } : {}),
        commerce: {
          available: offers.length > 0, retryable: offers.length === 0, provider: 'serper',
          providersTried: ['serper'], count: offers.length, ...(offers.length === 0 ? { errorType: 'no_results' } : {}),
          enrichmentCandidates: [],
        },
        funnel: { version: 'v127', cacheHit: false, discoveryMs: 40, earlyExit: false, deadlineMs: 1900 },
      });
    }

    // ── image-mode ────────────────────────────────────────────────────────
    const b64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
    if (!b64) { counters.rejected += 1; return send(400, { error: 'image required' }); }
    const image = known.get(digest(b64));
    if (!image) { counters.rejected += 1; return send(200, { status: 'failed', userMessage: 'unknown image' }); }

    if (body.requestMode === 'selected_item') {
      counters.selected += 1;
      await wait('selected');
      const session = sessions.get(body.scanSessionId);
      const cand = body.selectedCandidate;
      if (!session || !cand || !session.candidates.some((c) => c.candidateId === cand.candidateId)
        || !body.imageDigestPrefix || body.imageDigestPrefix !== session.imageDigestPrefix) {
        counters.rejected += 1;
        return send(200, { status: 'failed', userMessage: 'selected item invalid' });
      }
      const garment = session.garmentByCandidate.get(cand.candidateId);
      log.push({ kind: 'selected', imageId: image.id, candidateId: cand.candidateId });
      return send(200, {
        status: 'completed',
        scanSessionId: body.scanSessionId,
        imageDigestPrefix: session.imageDigestPrefix,
        attributes: { category: garment.categoryAny[0], itemType: garment.subtypeAny[0], colorPalette: [garment.colorAny[0]], confidenceScore: 0.82 },
        identification: {
          item_type: garment.subtypeAny[0], subtype: garment.subtypeAny[0], primary_color: garment.colorAny[0],
          material_estimate: (garment.materialAny ?? [])[0] ?? null, brand_guess: null, visible_brand_text: null,
          logo_detected: false, confidence_score: 0.82, non_fashion: false, visual_observation: `mock ${garment.key}`,
        },
        recommendedProducts: [],
        // The real server emits its shoppingMeta as `commerce`; the client reads `commerce.deferred === true`.
        commerce: { provider: 'deferred', count: 0, providersTried: [], deferred: true, funnelVersion: 'v127', reason: 'deferred_to_commerce_only_request' },
      });
    }

    counters.detection += 1;
    await wait('detection');
    if (image.nonFashion) {
      log.push({ kind: 'detection', imageId: image.id, garments: 0 });
      return send(200, { status: 'non_fashion', userMessage: 'No fashion item found.' });
    }
    const scanSessionId = body.scanSessionId ?? crypto.randomUUID();
    const imageDigestPrefix = digest(b64).slice(0, 12);
    const candidates = (image.expectedGarments ?? []).map((g, i) => ({
      candidateId: `garment-${i + 1}-${slug(g.categoryAny[0])}-${slug(g.subtypeAny[0])}`,
      order: i,
      label: g.subtypeAny[0],
      category: g.categoryAny[0],
      subtype: g.subtypeAny[0],
      bounds: { x: 0.1 * i, y: 0.1, width: 0.5, height: 0.6 },
      attributes: { category: g.categoryAny[0], colorPalette: [g.colorAny[0]] },
      identification: { item_type: g.subtypeAny[0], subtype: g.subtypeAny[0], primary_color: g.colorAny[0] },
    }));
    const garmentByCandidate = new Map(candidates.map((c, i) => [c.candidateId, image.expectedGarments[i]]));
    sessions.set(scanSessionId, { image, candidates, imageDigestPrefix, garmentByCandidate });
    log.push({ kind: 'detection', imageId: image.id, garments: candidates.length });
    return send(200, {
      status: 'completed',
      scanSessionId,
      imageDigestPrefix,
      attributes: { category: candidates[0].category, colorPalette: [candidates[0].identification.primary_color] },
      identification: { visual_observation: 'mock detection' },
      detectedGarments: candidates,
      recommendedProducts: [],
      commerce: { provider: 'deferred', count: 0, providersTried: [], deferred: true, funnelVersion: 'v127', reason: 'deferred_to_commerce_only_request' },
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => { res.writeHead(500); res.end(String(error?.message ?? error)); });
  });

  return {
    counters,
    log,
    token,
    /** Teach the mock which corpus image a prepared base64 payload is. */
    register(imageBase64, image) { known.set(digest(imageBase64), image); },
    failNext(status = 500, payload) { failNext = { status, payload }; },
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createMockEdge, safeString };
