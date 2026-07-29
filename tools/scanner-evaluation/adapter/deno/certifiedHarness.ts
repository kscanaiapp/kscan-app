// Certified v140 execution harness (Phase 0E Lane E2).
//
// Loads the CERTIFIED scan-identify entry from an external read-only source root
// and drives its real request handler with a deterministic mock provider.
//
// This file lives in the research branch and is never copied into the certified
// worktree. The certified source is reached through a file:// URL built from
// --cert-root, so no absolute workstation path is committed.
//
// HOW THE CERTIFIED PATH IS ACTUALLY EXERCISED
//   - `Deno.serve` is replaced before import, so importing the entry hands us
//     its real request handler instead of starting a listener.
//   - `globalThis.fetch` is replaced with a counting interceptor. The Gemini
//     host returns a deterministic mock envelope; EVERY other host throws and is
//     counted. There is no silent no-op anywhere.
//   - The handler then runs the certified request validation, V2 activation,
//     intent and evidence validation, prompt construction, model routing,
//     provider parsing, quality processing, normalization and V2 projection.
//
// SAFETY
//   - Run with `--deny-net` where the resolved dependency cache allows it; the
//     mock fetch means no syscall is needed either way.
//   - GEMINI_API_KEY is a synthetic placeholder. It is never sent anywhere,
//     because the only fetch that would carry it is intercepted.
//   - Nothing is logged that could contain a prompt, image bytes, a credential
//     or an Authorization header.
//
// Usage:
//   deno run --allow-read --allow-env --no-lock certifiedHarness.ts \
//     --cert-root <path> --scenario completed

type Json = Record<string, unknown>;

interface HarnessArgs {
  certRoot: string;
  scenario: string;
  mode: string;
  out: string | null;
}

function parseArgs(argv: string[]): HarnessArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const certRoot = get('--cert-root') ?? Deno.env.get('KSCAN_CERT_V140_ROOT') ?? null;
  const scenario = get('--scenario') ?? 'completed';
  const mode = get('--mode') ?? 'identify_selected_item';
  // The certified function logs to stdout, so the machine-readable result is
  // written to a file rather than interleaved with those lines.
  const out = get('--out');
  if (!certRoot) {
    throw new Error('no --cert-root and no KSCAN_CERT_V140_ROOT: refusing to guess the certified source');
  }
  return { certRoot, scenario, mode, out };
}

// ── Deterministic mock envelopes (mirror of the Node-side mock) ───────────────

function completedIdentification(): Json {
  return {
    identification: {
      item_type: 'footwear',
      subtype: 'low_top_sneaker',
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      primary_color: 'red',
      secondary_colors: ['white'],
      material_estimate: 'canvas',
      silhouette: 'low profile',
      pattern: 'solid',
      pockets: [],
      style_tags: ['casual'],
      occasion_tags: ['everyday'],
      distinctive_features: ['contrast midsole'],
      visual_observation: 'A red low-top lace-up sneaker with a white midsole.',
      confidence_score: 0.82,
      scan_quality_note: null,
      status: 'completed',
    },
    attributes: {
      category: 'footwear',
      colorPalette: ['red', 'white'],
      materialEstimate: 'canvas',
      confidenceScore: 0.82,
    },
  };
}

function scenarioBody(scenario: string): { text: string; fail?: boolean } {
  switch (scenario) {
    case 'completed':
      return { text: JSON.stringify(completedIdentification()) };
    case 'partial': {
      const env = completedIdentification() as Json;
      (env.identification as Json).subtype = null;
      (env.identification as Json).confidence_score = 0.44;
      return { text: JSON.stringify(env) };
    }
    case 'insufficient_visual_evidence':
      return {
        text: JSON.stringify({
          identification: {
            item_type: null, subtype: null, secondary_colors: [], pockets: [],
            style_tags: [], occasion_tags: [], distinctive_features: [],
            confidence_score: 0.08,
            scan_quality_note: 'Image is too dark and blurred to identify a garment.',
            status: 'insufficient_visual_evidence',
          },
          attributes: {},
        }),
      };
    case 'non_fashion':
      return {
        text: JSON.stringify({
          identification: {
            item_type: null, subtype: null, non_fashion: true, secondary_colors: [],
            pockets: [], style_tags: [], occasion_tags: [], distinctive_features: [],
            visual_observation: 'A ceramic mug on a table. No garment is present.',
            confidence_score: 0.91, status: 'non_fashion',
          },
          attributes: {},
        }),
      };
    case 'malformed_envelope':
      return { text: 'I could not analyse that image. Sorry!' };
    case 'schema_failure':
      return { text: JSON.stringify({ result: 'ok', data: { thing: 'a shoe, maybe' } }) };
    case 'primary_fails_fallback_succeeds':
    case 'primary_and_fallback_fail':
      return { text: JSON.stringify(completedIdentification()), fail: true };
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }
}

// ── Interception ─────────────────────────────────────────────────────────────

const counters = {
  modelCalls: 0,
  unexpectedNetworkAttempts: 0,
  supabaseHostAttempts: 0,
  commerceHostAttempts: 0,
};
const modelsUsed: string[] = [];
const blockedHosts: string[] = [];

const GEMINI_HOST = 'generativelanguage.googleapis.com';

function installFetchInterceptor(scenario: string) {
  const body = scenarioBody(scenario);

  globalThis.fetch = ((input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return 'unparseable';
      }
    })();

    if (host === GEMINI_HOST) {
      counters.modelCalls += 1;
      // Recover the model id from the certified URL builder's path.
      const model = (url.match(/models\/([^:?]+)/) || [])[1] || 'unknown';
      modelsUsed.push(model);

      const shouldFail =
        (scenario === 'primary_fails_fallback_succeeds' && counters.modelCalls === 1) ||
        scenario === 'primary_and_fallback_fail';

      if (shouldFail) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'mock upstream failure' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        );
      }

      // Gemini's real envelope: candidates[].content.parts[].text
      return Promise.resolve(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: body.text }] } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    }

    // Anything else is a boundary violation. Counted, recorded by HOST ONLY,
    // and thrown immediately. No request body, prompt, image or header is read.
    counters.unexpectedNetworkAttempts += 1;
    if (host.endsWith('supabase.co') || host.includes('supabase')) counters.supabaseHostAttempts += 1;
    else counters.commerceHostAttempts += 1;
    if (!blockedHosts.includes(host)) blockedHosts.push(host);
    throw new Error(`network denied by harness: host=${host}`);
  }) as typeof fetch;
}

let capturedHandler: ((req: Request) => Promise<Response>) | null = null;

function installServeInterceptor() {
  // Replacing Deno.serve BEFORE importing the entry gives us the real handler
  // without binding a port. `Deno.serve` is a getter-only property, so it must
  // be redefined rather than assigned.
  const fake = (handler: (req: Request) => Promise<Response>) => {
    capturedHandler = handler;
    return {
      finished: Promise.resolve(),
      shutdown: () => Promise.resolve(),
      ref: () => {},
      unref: () => {},
      addr: { hostname: '127.0.0.1', port: 0, transport: 'tcp' as const },
    };
  };
  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    writable: true,
    value: fake,
  });
}

function installEnv() {
  // Synthetic values only. The API key is never transmitted: the only fetch
  // that would carry it is intercepted above.
  const env: Record<string, string> = {
    GEMINI_API_KEY: 'harness-synthetic-key-not-a-credential',
    SUPABASE_URL: 'https://harness.invalid',
    SUPABASE_ANON_KEY: 'harness-synthetic-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'harness-synthetic-service',
    SCAN_MULTI_ITEM_ENABLED: 'true',
  };
  for (const [key, value] of Object.entries(env)) {
    if (!Deno.env.get(key)) Deno.env.set(key, value);
  }
  return Object.keys(env);
}

// ── Request construction (certified V2 contract values only) ─────────────────

/** A 1x1 JPEG. Synthetic; carries no personal data. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4oooA//9k=';

function buildV2Request(mode: string): Request {
  // The certified entry requires a selectedCandidate for identify_selected_item
  // (error code MISSING_SELECTED_CANDIDATE) — an application-level requirement
  // beyond contract validation. detect_items must NOT carry one.
  const selectedCandidate =
    mode === 'identify_selected_item'
      ? {
          selectedCandidate: {
            candidateId: 'harness-candidate-01',
            evidenceId: 'harness-evidence-01',
            category: 'footwear',
            subtype: 'sneaker',
            bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          },
        }
      : {};

  const body = {
    ...selectedCandidate,
    contractVersion: 'fashion-identification-v2',
    requestId: 'harness-request-0001',
    // Only intents present in certified v140. identify_for_closet was added
    // after certification and would be rejected as invalid_intent.
    intent: 'identify_for_style',
    mode,
    source: { entryPath: 'scanner_camera', platform: 'ios', appVersion: 'harness' },
    evidence: [
      {
        evidenceId: 'harness-evidence-01',
        sequenceIndex: 0,
        angleHint: 'front',
        transport: { type: 'jpeg_base64', imageBase64: TINY_JPEG_BASE64 },
        metadata: { schemaVersion: 'image-metadata-v1', width: 1, height: 1, mimeType: 'image/jpeg' },
      },
    ],
    privacy: { localFaceMaskApplied: false, localPlateMaskApplied: false, rawExifTransmitted: false },
  };

  // The certified anonymous image path requires project access, which
  // hasValidProjectAccess() decides by comparing the apikey header to
  // SUPABASE_ANON_KEY — a pure string comparison, no network. Supplying the
  // harness's own synthetic anon value satisfies it offline. This is NOT a real
  // credential and grants nothing outside this process.
  return new Request('https://harness.invalid/scan-identify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    },
    body: JSON.stringify(body),
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { certRoot, scenario, mode, out } = parseArgs(Deno.args);
  const envKeys = installEnv();
  installServeInterceptor();
  installFetchInterceptor(scenario);

  const entryUrl = new URL(
    `file:///${certRoot.replace(/\\/g, '/').replace(/^\/+/, '')}/supabase/functions/scan-identify/index.ts`
  ).href;

  await import(entryUrl);

  if (!capturedHandler) {
    throw new Error('certified entry did not register a handler via Deno.serve');
  }

  const request = buildV2Request(mode);
  let status = 0;
  let payload: unknown = null;
  let handlerError: string | null = null;

  try {
    const response = await capturedHandler(request);
    status = response.status;
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { unparseable: true, length: text.length };
    }
  } catch (error) {
    handlerError = error instanceof Error ? error.message : String(error);
  }

  const result = payload as Json | null;
  const report = JSON.stringify(
      {
        scenario,
        mode,
        certRootAccepted: true,
        httpStatus: status,
        handlerError,
        // Redacted environment: names only, never values.
        envVarNames: envKeys,
        observed: result
          ? {
              contractVersion: result.contractVersion ?? null,
              status: result.status ?? null,
              resolutionLevel: result.resolutionLevel ?? null,
              itemCategory: (result.item as Json | undefined)?.category ?? null,
              itemSubtype: (result.item as Json | undefined)?.subtype ?? null,
              exactProduct: result.exactProduct ?? null,
              commerceSkippedReason:
                (result.compatibility as Json | undefined)?.commerceSkippedReason ?? null,
              unknownReason: result.unknownReason ?? null,
            }
          : null,
        counters,
        modelsUsed,
        blockedHosts,
        // The full response body. Safe to surface: the request was constructed
        // by this harness from synthetic values, so the body cannot contain user
        // data, and no credential or Authorization header is echoed by the
        // certified error paths.
        rawPayload: result,
      },
      null,
      2
    );

  if (out) await Deno.writeTextFile(out, `${report}\n`);
  else console.log(report);
}

await main();
