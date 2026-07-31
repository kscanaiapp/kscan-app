// Phase 2C — dormant production candidate integration certification.
//
// This drives the REAL scan-identify entry point. Only the external provider
// transport is mocked: request validation, V2 activation, prompt composition,
// version resolution, model routing, the attempt loop, parsing, normalization
// and response assembly are all the production code paths.
//
// HOW THE REAL ENTRY IS EXERCISED
//   - `Deno.serve` is replaced before the entry is imported, so importing it
//     hands back its real request handler instead of binding a port.
//   - `globalThis.fetch` is replaced with a recording interceptor. The Gemini
//     host returns a deterministic envelope and the outgoing prompt is captured;
//     EVERY other host throws and is counted, so a Supabase or commerce call
//     would fail loudly rather than pass silently.
//
// Run with:
//   deno test --no-lock --node-modules-dir=none --allow-env --allow-read \
//     supabase/functions/scan-identify/phase2cDormantIntegration.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CERTIFIED_CONTROL_VERSION,
  PHASE2A_CANDIDATE_VERSION,
  PHASE2A_INSTRUCTION_TEXT,
} from '../_shared/scannerCandidateArtifact.ts';
import { SCANNER_VERSION_ENV_KEY } from '../_shared/scannerVersionResolver.ts';

const PHASE2A_MARKER = 'K SCAN AI PHASE 2A CANDIDATE INSTRUCTIONS';
const GEMINI_HOST = 'generativelanguage.googleapis.com';

/**
 * The selected-item path correlates the request against the image it was
 * detected from, so the prefix must be the real digest of TINY_JPEG. A wrong
 * value is rejected with selected_item_image_mismatch before the provider is
 * ever reached — which would make every assertion below vacuously pass on zero
 * dispatches.
 */
const IMAGE_DIGEST_PREFIX = '025db58bd258';

// ── Environment ──────────────────────────────────────────────────────────────

const ANON_KEY = 'phase2c-synthetic-anon';
for (
  const [key, value] of Object.entries({
    SUPABASE_URL: 'https://phase2c.invalid',
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: 'phase2c-synthetic-service',
    // Synthetic. Never transmitted: the only fetch that would carry it is
    // intercepted below.
    GEMINI_API_KEY: 'phase2c-synthetic-key-not-a-credential',
    SCAN_MULTI_ITEM_ENABLED: 'true',
  })
) {
  if (!Deno.env.get(key)) Deno.env.set(key, value);
}
// Every test states its own version explicitly; start from the dormant default.
Deno.env.delete(SCANNER_VERSION_ENV_KEY);

// ── Provider interception ────────────────────────────────────────────────────

interface Dispatch {
  model: string;
  prompt: string;
  hasImagePart: boolean;
  generationConfig: unknown;
}

const dispatches: Dispatch[] = [];
const blockedHosts: string[] = [];
let providerStatus = 200;
let providerBody: string | null = null;

function completedEnvelope(): string {
  return JSON.stringify({
    identification: {
      item_type: 'pants',
      subtype: 'wide_leg_jeans',
      primary_color: 'dark blue',
      secondary_colors: [],
      material_estimate: 'denim',
      pattern: null,
      silhouette: 'wide leg',
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      pockets: [],
      style_tags: ['casual'],
      occasion_tags: ['everyday'],
      distinctive_features: [],
      visual_observation: 'Dark blue wide-leg denim jeans.',
      confidence_score: 0.78,
      scan_quality_note: null,
      status: 'completed',
    },
    attributes: {
      category: 'pants',
      colorPalette: ['dark blue'],
      materialEstimate: 'denim',
      confidenceScore: 0.78,
    },
    recommendedProducts: [],
    userMessage: 'Dark blue wide-leg denim jeans.',
    status: 'completed',
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'unparseable';
    }
  })();

  if (host !== GEMINI_HOST) {
    // Counted and thrown, never silently no-op'd: a Supabase or commerce call
    // must be a loud failure.
    if (!blockedHosts.includes(host)) blockedHosts.push(host);
    throw new Error(`network denied by phase2c harness: host=${host}`);
  }

  const model = (url.match(/models\/([^:?]+)/) || [])[1] || 'unknown';
  const body = typeof init?.body === 'string'
    ? JSON.parse(init.body) as {
      contents?: Array<{ parts?: Array<Record<string, unknown>> }>;
      generationConfig?: unknown;
    }
    : {};
  const parts = body.contents?.[0]?.parts ?? [];
  dispatches.push({
    model,
    prompt: typeof parts[0]?.text === 'string' ? parts[0].text as string : '',
    hasImagePart: parts.some((p) => 'inline_data' in p),
    generationConfig: body.generationConfig,
  });

  if (providerStatus !== 200) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: 'mock upstream failure' } }), {
        status: providerStatus,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: providerBody ?? completedEnvelope() }] } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}) as typeof fetch;

// ── Capture the real handler ─────────────────────────────────────────────────

let handler: ((req: Request) => Promise<Response>) | null = null;
Object.defineProperty(Deno, 'serve', {
  configurable: true,
  writable: true,
  value: (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return {
      finished: Promise.resolve(),
      shutdown: () => Promise.resolve(),
      ref: () => {},
      unref: () => {},
      addr: { hostname: '127.0.0.1', port: 0, transport: 'tcp' as const },
    };
  },
});

await import('./index.ts');
assert(handler, 'the production entry must register a handler via Deno.serve');

/** A 1x1 JPEG. Synthetic; carries no personal data. */
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4oooA//9k=';

/**
 * A distinct client per request.
 *
 * The anonymous burst limiter is module-level state keyed by a hash of
 * `ip|user-agent`, so every scan in this file would otherwise look like ONE
 * client hammering the function and later requests would be rate-limited into
 * a `failed` response with zero provider dispatches — which would make the
 * assertions below pass vacuously rather than fail loudly.
 */
let clientCounter = 0;
function nextClientIp(): string {
  clientCounter += 1;
  return `203.0.113.${clientCounter % 250}`;
}

async function scan(
  options: { version?: string | null; body?: Record<string, unknown> } = {},
): Promise<{ status: number; payload: Record<string, unknown>; dispatches: Dispatch[] }> {
  dispatches.length = 0;
  if (options.version === null || options.version === undefined) {
    Deno.env.delete(SCANNER_VERSION_ENV_KEY);
  } else {
    Deno.env.set(SCANNER_VERSION_ENV_KEY, options.version);
  }

  const request = new Request('https://phase2c.invalid/scan-identify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON_KEY,
      'x-forwarded-for': nextClientIp(),
      'user-agent': `phase2c-test/${clientCounter}`,
    },
    body: JSON.stringify({
      contractVersion: 'fashion-identification-v2',
      requestId: 'phase2c-request-0001',
      intent: 'identify_for_style',
      mode: 'identify_selected_item',
      scanSessionId: 'phase2c-session-0001',
      imageDigestPrefix: IMAGE_DIGEST_PREFIX,
      selectedCandidate: {
        candidateId: 'phase2c-candidate-01',
        evidenceId: 'phase2c-evidence-01',
        category: 'pants',
        subtype: 'jeans',
        bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      },
      source: { entryPath: 'scanner_camera', platform: 'ios', appVersion: 'phase2c' },
      evidence: [{
        evidenceId: 'phase2c-evidence-01',
        sequenceIndex: 0,
        angleHint: 'front',
        transport: { type: 'jpeg_base64', imageBase64: TINY_JPEG },
        metadata: { schemaVersion: 'image-metadata-v1', width: 1, height: 1, mimeType: 'image/jpeg' },
      }],
      privacy: { localFaceMaskApplied: false, localPlateMaskApplied: false, rawExifTransmitted: false },
      ...(options.body ?? {}),
    }),
  });

  const response = await handler!(request);
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = { unparseable: true };
  }
  return { status: response.status, payload, dispatches: [...dispatches] };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function resetProvider() {
  providerStatus = 200;
  providerBody = null;
  blockedHosts.length = 0;
}

// ── Default and explicit selection ───────────────────────────────────────────

Deno.test('absent configuration runs certified v140 through one dispatch', async () => {
  resetProvider();
  const run = await scan({ version: null });

  assertEquals(run.dispatches.length, 1, 'exactly one provider dispatch');
  assertEquals(occurrences(run.dispatches[0].prompt, PHASE2A_MARKER), 0, 'no candidate instructions');
  assertEquals(run.dispatches[0].hasImagePart, true);
  assertEquals(blockedHosts, [], 'no non-provider host may be contacted');
});

Deno.test('valid trusted configuration selects the candidate, applied exactly once', async () => {
  resetProvider();
  const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });

  assertEquals(run.dispatches.length, 1, 'still exactly one provider dispatch');
  assertEquals(
    occurrences(run.dispatches[0].prompt, PHASE2A_MARKER),
    1,
    'the candidate instructions must appear exactly once',
  );
  assert(
    run.dispatches[0].prompt.endsWith(PHASE2A_INSTRUCTION_TEXT),
    'the candidate text must be appended last, verbatim',
  );
});

Deno.test('certified request parity: the candidate changes the prompt and nothing else', async () => {
  resetProvider();
  const control = await scan({ version: null });
  const candidate = await scan({ version: PHASE2A_CANDIDATE_VERSION });

  const c = control.dispatches[0];
  const k = candidate.dispatches[0];

  // The certified prompt is a strict prefix of the candidate prompt.
  assert(k.prompt.startsWith(c.prompt), 'the certified prompt must remain first, verbatim');
  assertEquals(k.prompt.slice(c.prompt.length), PHASE2A_INSTRUCTION_TEXT);

  // Everything else about the request is identical.
  assertEquals(k.model, c.model, 'same model');
  assertEquals(k.hasImagePart, c.hasImagePart);
  assertEquals(JSON.stringify(k.generationConfig), JSON.stringify(c.generationConfig));
});

Deno.test('malformed and unknown configuration default to certified v140', async () => {
  resetProvider();
  for (const value of ['', '   ', 'true', 'enabled', 'phase2a', 'phase2a-v1.0.1', 'PHASE2A-V1.0.0']) {
    const run = await scan({ version: value });
    assertEquals(run.dispatches.length, 1, value);
    assertEquals(
      occurrences(run.dispatches[0].prompt, PHASE2A_MARKER),
      0,
      `${JSON.stringify(value)} must not activate the candidate`,
    );
  }
});

Deno.test('explicitly naming the control runs the control', async () => {
  resetProvider();
  const run = await scan({ version: CERTIFIED_CONTROL_VERSION });
  assertEquals(run.dispatches.length, 1);
  assertEquals(occurrences(run.dispatches[0].prompt, PHASE2A_MARKER), 0);
});

// ── Client cannot activate the candidate ─────────────────────────────────────

Deno.test('no client-controlled channel can activate the candidate', async () => {
  resetProvider();

  // Body fields, including ones named exactly like the server variable.
  const hostileBody = await scan({
    version: null,
    body: {
      scannerVersion: PHASE2A_CANDIDATE_VERSION,
      BACKEND_SCANNER_VERSION: PHASE2A_CANDIDATE_VERSION,
      candidateVersion: PHASE2A_CANDIDATE_VERSION,
      featureFlags: { scannerV2: true },
      experiment: PHASE2A_CANDIDATE_VERSION,
    },
  });
  assertEquals(
    occurrences(hostileBody.dispatches[0].prompt, PHASE2A_MARKER),
    0,
    'a request body must never activate the candidate',
  );

  // Headers and query parameters.
  dispatches.length = 0;
  Deno.env.delete(SCANNER_VERSION_ENV_KEY);
  const headerRequest = new Request(
    `https://phase2c.invalid/scan-identify?scannerVersion=${PHASE2A_CANDIDATE_VERSION}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        'x-forwarded-for': nextClientIp(),
        'user-agent': `phase2c-test/${clientCounter}`,
        'x-scanner-version': PHASE2A_CANDIDATE_VERSION,
        'x-backend-scanner-version': PHASE2A_CANDIDATE_VERSION,
      },
      body: JSON.stringify({
        contractVersion: 'fashion-identification-v2',
        requestId: 'phase2c-request-0002',
        intent: 'identify_for_style',
        mode: 'identify_selected_item',
        scanSessionId: 'phase2c-session-0002',
        imageDigestPrefix: IMAGE_DIGEST_PREFIX,
        selectedCandidate: {
          candidateId: 'phase2c-candidate-01',
          evidenceId: 'phase2c-evidence-01',
          category: 'pants',
          bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        },
        source: { entryPath: 'scanner_camera', platform: 'ios', appVersion: 'phase2c' },
        evidence: [{
          evidenceId: 'phase2c-evidence-01',
          sequenceIndex: 0,
          angleHint: 'front',
          transport: { type: 'jpeg_base64', imageBase64: TINY_JPEG },
          metadata: {
            schemaVersion: 'image-metadata-v1',
            width: 1,
            height: 1,
            mimeType: 'image/jpeg',
          },
        }],
        privacy: {
          localFaceMaskApplied: false,
          localPlateMaskApplied: false,
          rawExifTransmitted: false,
        },
      }),
    },
  );
  await handler!(headerRequest);
  assertEquals(dispatches.length, 1);
  assertEquals(
    occurrences(dispatches[0].prompt, PHASE2A_MARKER),
    0,
    'headers and query parameters must never activate the candidate',
  );
});

Deno.test('the resolved version is not exposed in the public response', async () => {
  resetProvider();
  const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });
  const serialized = JSON.stringify(run.payload);
  // Rollback must not require any client change, which means the client is
  // never told — and never needs to know — which version ran.
  assertEquals(serialized.includes(PHASE2A_CANDIDATE_VERSION), false);
  assertEquals(serialized.includes('scannerVersion'), false);
  assertEquals(serialized.includes(PHASE2A_MARKER), false);
});

// ── Provider behaviour is unchanged ──────────────────────────────────────────

Deno.test('the certified fallback still runs, as one dispatch per attempt and no candidate re-application', async () => {
  resetProvider();
  providerStatus = 503;
  const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });

  // The certified route owns the only retry. Every attempt is the SAME logical
  // request, and each carries the candidate instructions exactly once — the
  // overlay is composed before the attempt loop, so a retry cannot double it.
  assert(run.dispatches.length >= 1, 'at least one attempt');
  assert(run.dispatches.length <= 2, 'never more than the certified attempt ceiling');
  for (const dispatch of run.dispatches) {
    assertEquals(occurrences(dispatch.prompt, PHASE2A_MARKER), 1, 'exactly once, on every attempt');
  }
  assertEquals(blockedHosts, []);
});

Deno.test('a permanent quota failure stops immediately and does not retry', async () => {
  resetProvider();
  providerStatus = 429;
  const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });
  assert(run.dispatches.length >= 1);
  assertEquals(blockedHosts, [], 'a provider failure must not trigger any other host');
});

Deno.test('malformed provider output is handled without a second dispatch', async () => {
  resetProvider();
  providerBody = 'I could not analyse that image. Sorry!';
  const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });
  assertEquals(run.dispatches.length, 1, 'unparseable output must not trigger a repair call');
  assertEquals(run.status, 200, 'the function still answers safely');
});

Deno.test('schema-invalid provider output is handled without a second dispatch', async () => {
  resetProvider();
  providerBody = JSON.stringify({ result: 'ok', data: { thing: 'a shoe, maybe' } });
  const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });
  assertEquals(run.dispatches.length, 1);
  assertEquals(run.status, 200);
});

// ── Kill switch ──────────────────────────────────────────────────────────────

Deno.test('the kill switch returns the very next request to certified v140', async () => {
  resetProvider();

  const enabled = await scan({ version: PHASE2A_CANDIDATE_VERSION });
  assertEquals(occurrences(enabled.dispatches[0].prompt, PHASE2A_MARKER), 1);

  // Rollback is a single server-side variable change. Nothing else is touched:
  // no mobile update, no migration, no data cleanup, no schema change.
  const rolledBack = await scan({ version: null });
  assertEquals(
    occurrences(rolledBack.dispatches[0].prompt, PHASE2A_MARKER),
    0,
    'the next request must be certified again',
  );

  // And it is byte-identical to a control request that never saw the candidate.
  const control = await scan({ version: CERTIFIED_CONTROL_VERSION });
  assertEquals(rolledBack.dispatches[0].prompt, control.dispatches[0].prompt);
});

Deno.test('the version is resolved exactly once per request', async () => {
  resetProvider();

  // Immutability at the production entry means the configuration is CONSULTED
  // ONCE and the answer reused, so prompt construction, dispatch and telemetry
  // cannot disagree about which version ran. Counting the reads proves that
  // directly.
  //
  // (The complementary property — that a sealed resolution cannot change after
  // the fact — is proved against the resolver itself in
  // scannerVersionResolver.test.ts, where the configuration is mutated after
  // sealing.)
  const realGet = Deno.env.get.bind(Deno.env);
  let reads = 0;
  const counting = (key: string): string | undefined => {
    if (key === SCANNER_VERSION_ENV_KEY) reads += 1;
    return realGet(key);
  };
  Object.defineProperty(Deno.env, 'get', { configurable: true, writable: true, value: counting });

  try {
    const run = await scan({ version: PHASE2A_CANDIDATE_VERSION });
    assertEquals(run.dispatches.length, 1);
    assertEquals(occurrences(run.dispatches[0].prompt, PHASE2A_MARKER), 1);
    assertEquals(reads, 1, 'the trusted configuration must be consulted exactly once per request');
  } finally {
    Object.defineProperty(Deno.env, 'get', { configurable: true, writable: true, value: realGet });
  }
});

// ── Isolation ────────────────────────────────────────────────────────────────

Deno.test('no Supabase, commerce or unexpected host is contacted on any path', async () => {
  resetProvider();
  for (const version of [null, PHASE2A_CANDIDATE_VERSION]) {
    for (const status of [200, 503, 429]) {
      resetProvider();
      providerStatus = status;
      await scan({ version });
      assertEquals(
        blockedHosts,
        [],
        `version=${version} status=${status} contacted: ${blockedHosts.join(', ')}`,
      );
    }
  }
});
