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

interface DenoRuntime {
  args: string[];
  env: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
  };
  readFileSync(file: string): Uint8Array;
  writeTextFile(file: string, data: string): Promise<void>;
}

// Referencing the runtime through a narrow local interface keeps this harness
// type-checkable under both the repository's Expo TypeScript config and Deno.
const denoRuntime = (globalThis as unknown as { Deno: DenoRuntime }).Deno;

interface HarnessArgs {
  certRoot: string;
  scenario: string;
  mode: string;
  out: string | null;
  /** 'mock' drives the deterministic envelope. 'live' reaches the real provider. */
  provider: string;
  /** Governed image to evaluate. Required in live mode; never logged. */
  imageFile: string | null;
  imageWidth: number;
  imageHeight: number;
  /** Opaque case id. Carries no provenance and is safe to record. */
  caseId: string;
  timeoutMs: number;
  /** Explicitly selected execution. Defaults to the certified control. */
  candidateVersion: string;
  /** Overlay artifact for a candidate run. Required when a candidate is selected. */
  overlayFile: string | null;
}

// ── Candidate instruction overlay ────────────────────────────────────────────
//
// The certified handler builds the entire provider request: URL, model, prompt,
// generationConfig and image part. The certified source is immutable, so the ONE
// place a candidate can add instructions without editing it is the outgoing
// request body, at the transport boundary this harness already owns.
//
// The overlay is APPENDED to the leading text part. The certified prompt still
// reaches the provider first, verbatim, and everything else — the image bytes,
// the generation config, the model, the retry loop, the timeout — is untouched.
//
// The overlay text is read from the same JSON artifact the Node harness reads,
// so the two runtimes cannot drift apart, and its recorded hash is re-derived
// here before it is applied.

const CONTROL_VERSION = 'certified-v140';

interface OverlayArtifact {
  overlayId: string;
  candidateVersion: string;
  mechanism: string;
  textSha256: string;
  lines: string[];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadOverlay(file: string, candidateVersion: string): Promise<{ overlayId: string; text: string; textSha256: string }> {
  const artifact = JSON.parse(new TextDecoder().decode(denoRuntime.readFileSync(file))) as OverlayArtifact;
  if (artifact.mechanism !== 'append') {
    throw new Error(`unsupported overlay mechanism: ${artifact.mechanism}`);
  }
  if (artifact.candidateVersion !== candidateVersion) {
    throw new Error(
      `overlay declares candidate ${artifact.candidateVersion}, but ${candidateVersion} was selected`,
    );
  }
  if (!Array.isArray(artifact.lines) || artifact.lines.length === 0) {
    throw new Error('overlay artifact carries no lines');
  }
  const text = artifact.lines.join('\n');
  const derived = await sha256Hex(text);
  if (derived !== artifact.textSha256) {
    throw new Error(`overlay text hashes to ${derived} but the artifact records ${artifact.textSha256}`);
  }
  return { overlayId: artifact.overlayId, text, textSha256: derived };
}

/** Applied to the request body the certified code produced. Pure and deterministic. */
let candidateOverlay: { overlayId: string; text: string; textSha256: string } | null = null;
const overlayApplications = { requests: 0, promptsExtended: 0 };

/** The leading text part of an outgoing request, or '' when there is none. */
function promptTextOf(init: RequestInit | undefined): string {
  if (!init || typeof init.body !== 'string') return '';
  try {
    const parsed = JSON.parse(init.body) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
    const part = parsed.contents && parsed.contents[0] && parsed.contents[0].parts && parsed.contents[0].parts[0];
    return part && typeof part.text === 'string' ? part.text : '';
  } catch {
    return '';
  }
}

function applyOverlayToRequestInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!candidateOverlay || !init || typeof init.body !== 'string') return init;
  overlayApplications.requests += 1;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    // Not a JSON body: the certified path always sends one, so refuse rather
    // than silently shipping an un-overlaid candidate request.
    throw new Error('candidate overlay could not parse the certified request body');
  }
  const contents = body.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined;
  const part = contents && contents[0] && contents[0].parts && contents[0].parts[0];
  if (!part || typeof part.text !== 'string' || part.text.length === 0) {
    throw new Error('candidate overlay found no leading text part in the certified request');
  }
  part.text = `${part.text}${candidateOverlay.text}`;
  overlayApplications.promptsExtended += 1;
  return { ...init, body: JSON.stringify(body) };
}

function parseArgs(argv: string[]): HarnessArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const certRoot = get('--cert-root') ?? denoRuntime.env.get('KSCAN_CERT_V140_ROOT') ?? null;
  const scenario = get('--scenario') ?? 'completed';
  const mode = get('--mode') ?? 'identify_selected_item';
  // The certified function logs to stdout, so the machine-readable result is
  // written to a file rather than interleaved with those lines.
  const out = get('--out');
  if (!certRoot) {
    throw new Error('no --cert-root and no KSCAN_CERT_V140_ROOT: refusing to guess the certified source');
  }

  const provider = get('--provider') ?? 'mock';
  if (!['mock', 'live', 'count-tokens'].includes(provider)) throw new Error(`unknown --provider: ${provider}`);

  const imageFile = get('--image-file');
  const imageWidth = Number(get('--image-width') ?? '0');
  const imageHeight = Number(get('--image-height') ?? '0');
  const caseId = get('--case-id') ?? 'unlabelled';
  const timeoutMs = Number(get('--timeout-ms') ?? '14000');

  // Selection is explicit. Passing nothing runs the certified control; passing a
  // candidate requires naming it AND supplying its overlay artifact, so a
  // candidate can never run with the control's instructions or vice versa.
  const candidateVersion = get('--candidate-version') ?? CONTROL_VERSION;
  const overlayFile = get('--overlay-file');
  if (candidateVersion !== CONTROL_VERSION && !overlayFile) {
    throw new Error(`candidate ${candidateVersion} requires --overlay-file`);
  }
  if (candidateVersion === CONTROL_VERSION && overlayFile) {
    throw new Error('the certified control may not be given an instruction overlay');
  }

  if ((provider === 'live' || provider === 'count-tokens') && !imageFile) {
    // Fail closed rather than silently evaluating a synthetic 1x1 pixel.
    throw new Error(`${provider} mode requires --image-file`);
  }
  if (imageFile) {
    if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) {
      throw new Error('--image-file requires positive --image-width and --image-height');
    }
  }
  if ((provider === 'live' || provider === 'count-tokens') && !denoRuntime.env.get('GEMINI_API_KEY')) {
    throw new Error(`${provider} mode requires GEMINI_API_KEY in the process environment`);
  }

  return {
    certRoot, scenario, mode, out, provider, imageFile, imageWidth, imageHeight, caseId, timeoutMs,
    candidateVersion, overlayFile,
  };
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

/**
 * PROMPT-SENSITIVE PROBE.
 *
 * Every other scenario answers the same way no matter what was asked, which is
 * right for testing transport and parsing but cannot demonstrate that the
 * candidate's INSTRUCTIONS reach the model and change what comes back.
 *
 * This scenario stands in for a model that reads its instructions. Given the
 * certified prompt alone it answers the way an uninstructed model does — a
 * generic object label, no subtype, a material inferred rather than observed,
 * and a pattern asserted on an image that does not support one. Given the
 * certified prompt PLUS the Phase 2A overlay it answers the way the overlay
 * asks: a fashion term, a subtype in the same family, a material it can see,
 * and an abstention where it cannot tell.
 *
 * The difference is produced by the MECHANISM — the overlay reaching the
 * provider — not by the test choosing an outcome per side. Both envelopes are
 * ordinary model output; neither the scorer nor any governed label is touched.
 */
const PHASE2A_OVERLAY_MARKER = 'K SCAN AI PHASE 2A CANDIDATE INSTRUCTIONS';

function specificityProbeBody(promptText: string): { text: string } {
  const instructed = promptText.includes(PHASE2A_OVERLAY_MARKER);
  const identification = instructed
    ? {
      item_type: 'pants',
      subtype: 'wide_leg_jeans',
      primary_color: 'dark blue',
      secondary_colors: [],
      material_estimate: 'denim',
      // Not visible on this frame, so declined through the shape's own
      // representation rather than guessed at.
      pattern: null,
      silhouette: 'wide leg',
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      pockets: [],
      style_tags: ['casual'],
      occasion_tags: ['everyday'],
      distinctive_features: ['contrast stitching'],
      visual_observation: 'Dark blue wide-leg denim jeans.',
      confidence_score: 0.71,
      scan_quality_note: null,
      status: 'completed',
    }
    : {
      item_type: 'clothing',
      subtype: null,
      primary_color: 'blue',
      secondary_colors: [],
      material_estimate: 'cotton',
      pattern: 'solid',
      silhouette: null,
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      pockets: [],
      style_tags: [],
      occasion_tags: [],
      distinctive_features: [],
      visual_observation: 'An item of clothing.',
      confidence_score: 0.71,
      scan_quality_note: null,
      status: 'completed',
    };
  return {
    text: JSON.stringify({
      identification,
      attributes: {
        category: identification.item_type,
        colorPalette: [identification.primary_color],
        materialEstimate: identification.material_estimate,
        confidenceScore: identification.confidence_score,
      },
    }),
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
    case 'fashion_specificity_probe':
      // Resolved per request from the outgoing prompt; this branch exists only
      // so the scenario name validates here as well.
      return specificityProbeBody('');
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

/** Per-attempt provider telemetry. Never holds a prompt, a response body or a key. */
const providerAttempts: Array<{
  model: string;
  httpStatus: number;
  latencyMs: number;
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  totalTokenCount: number | null;
  errorCategory: string | null;
  certifiedFailureKind: string | null;
}> = [];

/**
 * Live transport.
 *
 * The certified code builds the URL, the prompt and the request body; this only
 * lets that request reach the real host and records timing and usage on the way
 * back. Every non-Gemini host stays blocked exactly as in mock mode.
 *
 * The response is cloned before the certified parser consumes it, so usage
 * metadata can be read without disturbing the certified path. Only the numeric
 * token counts are retained — never the candidate text.
 */
function installLiveFetchInterceptor(
  timeoutMs: number,
  classifyProviderHttpFailure: (
    status: number,
    meta?: { code?: number | string; status?: string; message?: string },
  ) => string,
) {
  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return 'unparseable';
      }
    })();

    if (host !== GEMINI_HOST) {
      counters.unexpectedNetworkAttempts += 1;
      if (host.endsWith('supabase.co') || host.includes('supabase')) counters.supabaseHostAttempts += 1;
      else counters.commerceHostAttempts += 1;
      if (!blockedHosts.includes(host)) blockedHosts.push(host);
      throw new Error(`network denied by harness: host=${host}`);
    }

    counters.modelCalls += 1;
    const model = (url.match(/models\/([^:?]+)/) || [])[1] || 'unknown';
    modelsUsed.push(model);

    // Bounded by construction. The certified path has its own timeout; this is a
    // hard backstop so a hung socket cannot stall the run indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    let httpStatus = 0;
    let errorCategory: string | null = null;
    let certifiedFailureKind: string | null = null;

    // Candidate instructions are appended to the body the certified code built.
    // In control mode this is the identity transform.
    const overlaid = applyOverlayToRequestInit(init);

    try {
      const response = await realFetch(input as RequestInfo, { ...overlaid, signal: controller.signal });
      httpStatus = response.status;
      const latencyMs = performance.now() - started;

      let promptTokenCount: number | null = null;
      let candidatesTokenCount: number | null = null;
      let totalTokenCount: number | null = null;
      try {
        // Clone so the certified parser still receives an unread body.
        const body = await response.clone().json();
        const usage = body?.usageMetadata;
        if (usage) {
          promptTokenCount = usage.promptTokenCount ?? null;
          candidatesTokenCount = usage.candidatesTokenCount ?? null;
          totalTokenCount = usage.totalTokenCount ?? null;
        }
        if (httpStatus >= 400) {
          certifiedFailureKind = classifyProviderHttpFailure(httpStatus, {
            code: body?.error?.code,
            status: body?.error?.status,
            message: body?.error?.message,
          });
        }
      } catch {
        // A non-JSON or already-errored body carries no usage. Not fatal.
      }

      if (httpStatus >= 500) errorCategory = 'provider_5xx';
      else if (httpStatus === 429) errorCategory = 'provider_rate_limited';
      else if (httpStatus >= 400) errorCategory = 'provider_4xx';

      providerAttempts.push({
        model,
        httpStatus,
        latencyMs,
        promptTokenCount,
        candidatesTokenCount,
        totalTokenCount,
        errorCategory,
        certifiedFailureKind,
      });
      return response;
    } catch (error) {
      const latencyMs = performance.now() - started;
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      errorCategory = aborted ? 'timeout' : 'transport_error';
      providerAttempts.push({
        model,
        httpStatus: 0,
        latencyMs,
        promptTokenCount: null,
        candidatesTokenCount: null,
        totalTokenCount: null,
        errorCategory,
        certifiedFailureKind: aborted ? 'timeout' : 'network',
      });
      throw error;
    } finally {
      // Always cleared, on every path, so no timer keeps the process alive.
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

// PHASE 3 LIVE-EVALUATION ADDITION. Reuses the certified request-builder to get
// a byte-perfect prompt/image body for the cost-reservation preflight, without
// ever persisting that body: it is captured in memory, used for two REAL
// `:countTokens` calls (primary and fallback model — token count does not
// depend on which model receives the request, only the URL path does), and
// discarded. `:countTokens` is never `:generateContent` — no generation and no
// billed output happens here, only an input-token count.
class CountTokensCaptured extends Error {
  constructor() {
    super('count-tokens: captured and dispatched, aborting the certified handler');
    this.name = 'CountTokensCaptured';
  }
}

const tokenCounts: {
  primary: number | null;
  fallback: number | null;
  serializedRequestPayloadSha256: string | null;
  promptSha256: string | null;
  generationConfigSha256: string | null;
} = { primary: null, fallback: null, serializedRequestPayloadSha256: null, promptSha256: null, generationConfigSha256: null };

/** No-value sentinel, distinct from any real hash, for a field the certified request never carries. */
const ABSENT_FIELD_SHA256 = 'absent-field-sha256-placeholder-not-a-real-digest';

function installCountTokensInterceptor(primaryModel: string, fallbackModel: string) {
  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return 'unparseable';
      }
    })();
    if (host !== GEMINI_HOST) {
      counters.unexpectedNetworkAttempts += 1;
      throw new Error(`network denied by harness: host=${host}`);
    }

    const overlaid = applyOverlayToRequestInit(init);
    if (!overlaid || typeof overlaid.body !== 'string') {
      throw new Error('count-tokens: certified request carried no JSON body to count');
    }
    let parsedBody: { contents?: unknown; generationConfig?: unknown };
    try {
      parsedBody = JSON.parse(overlaid.body) as { contents?: unknown; generationConfig?: unknown };
    } catch {
      throw new Error('count-tokens: certified request body did not parse as JSON');
    }
    const { contents, generationConfig } = parsedBody;
    if (!contents) throw new Error('count-tokens: certified request body carried no contents');

    // Cache-identity hashes only -- reservation bookkeeping needs to prove two
    // requests are identical, not what they contain. Computed from the exact
    // certified bytes, in-process, and never carries the text/image forward:
    // the certified request never has a systemInstruction or tools field, so
    // those two use a fixed non-empty sentinel rather than fabricating content.
    tokenCounts.serializedRequestPayloadSha256 = await sha256Hex(overlaid.body);
    tokenCounts.promptSha256 = await sha256Hex(promptTextOf(overlaid));
    tokenCounts.generationConfigSha256 = await sha256Hex(JSON.stringify(generationConfig ?? null));

    // Only `contents` crosses to the countTokens call — generationConfig, tools
    // and safety settings are irrelevant to an input token count and dropped
    // rather than risk a strict-schema 400 on a field this endpoint does not
    // expect.
    const countBody = JSON.stringify({ contents });
    const apiKey = denoRuntime.env.get('GEMINI_API_KEY');

    for (const model of [primaryModel, fallbackModel]) {
      const countUrl = `https://${GEMINI_HOST}/v1beta/models/${model}:countTokens?key=${apiKey}`;
      const response = await realFetch(countUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: countBody,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`count-tokens: ${model} responded ${response.status}: ${text.slice(0, 200)}`);
      }
      const parsed = (await response.json()) as { totalTokens?: number };
      if (!Number.isInteger(parsed.totalTokens)) {
        throw new Error(`count-tokens: ${model} response carried no integer totalTokens`);
      }
      if (model === primaryModel) tokenCounts.primary = parsed.totalTokens as number;
      else tokenCounts.fallback = parsed.totalTokens as number;
    }

    // The captured body (contents, i.e. prompt text + image bytes) goes out of
    // scope here and is never written anywhere. Abort the certified handler now
    // that both real counts are in hand — no generateContent call is needed.
    throw new CountTokensCaptured();
  }) as typeof fetch;
}

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
      // The mock never sends the body anywhere, but the overlay is still applied
      // and counted here: a mock run must be able to PROVE the candidate request
      // was constructed, otherwise a candidate could pass every mocked test
      // while shipping the control's prompt in a live run.
      const effective = applyOverlayToRequestInit(_init) ?? _init;
      counters.modelCalls += 1;
      // Recover the model id from the certified URL builder's path.
      const model = (url.match(/models\/([^:?]+)/) || [])[1] || 'unknown';
      modelsUsed.push(model);

      const shouldFail =
        (scenario === 'primary_fails_fallback_succeeds' && counters.modelCalls === 1) ||
        scenario === 'primary_and_fallback_fail';

      if (shouldFail) {
        providerAttempts.push({
          model,
          httpStatus: 503,
          latencyMs: 0,
          promptTokenCount: null,
          candidatesTokenCount: null,
          totalTokenCount: null,
          errorCategory: 'provider_5xx',
          certifiedFailureKind: 'http_5xx_transient',
        });
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'mock upstream failure' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        );
      }

      // The probe answers the prompt it actually received.
      const responseText = scenario === 'fashion_specificity_probe'
        ? specificityProbeBody(promptTextOf(effective)).text
        : body.text;

      // Gemini's real envelope: candidates[].content.parts[].text
      providerAttempts.push({
        model,
        httpStatus: 200,
        latencyMs: 0,
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
        errorCategory: null,
        certifiedFailureKind: null,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: responseText }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
          }),
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
  Object.defineProperty(denoRuntime, 'serve', {
    configurable: true,
    writable: true,
    value: fake,
  });
}

function installEnv(provider: string) {
  // Synthetic values only. In mock mode the API key is never transmitted, because
  // the only fetch that would carry it is intercepted above.
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://harness.invalid',
    SUPABASE_ANON_KEY: 'harness-synthetic-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'harness-synthetic-service',
    SCAN_MULTI_ITEM_ENABLED: 'true',
  };
  if (provider !== 'live' && provider !== 'count-tokens') {
    env.GEMINI_API_KEY = 'harness-synthetic-key-not-a-credential';
  }
  // In live and count-tokens mode the owner-approved key is inherited from the
  // process environment and is never written, echoed or defaulted here.
  for (const [key, value] of Object.entries(env)) {
    if (!denoRuntime.env.get(key)) denoRuntime.env.set(key, value);
  }
  return Object.keys(env);
}

// ── Request construction (certified V2 contract values only) ─────────────────

/** A 1x1 JPEG. Synthetic; carries no personal data. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4oooA//9k=';

/** Base64 without pulling the whole file through a string intermediate twice. */
function base64OfFile(file: string): string {
  const bytes = denoRuntime.readFileSync(file);
  if (bytes.byteLength === 0) throw new Error('governed image is zero bytes');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

async function buildV2Request(mode: string, image?: { base64: string; width: number; height: number }): Promise<Request> {
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

  const imageBase64 = image ? image.base64 : TINY_JPEG_BASE64;
  const body = {
    ...selectedCandidate,
    ...(mode === 'identify_selected_item'
      ? { scanSessionId: 'harness-session-0001', imageDigestPrefix: await sha256Prefix(imageBase64) }
      : {}),
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
        transport: { type: 'jpeg_base64', imageBase64 },
        metadata: {
          schemaVersion: 'image-metadata-v1',
          width: image ? image.width : 1,
          height: image ? image.height : 1,
          mimeType: 'image/jpeg',
        },
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
      apikey: denoRuntime.env.get('SUPABASE_ANON_KEY') ?? '',
    },
    body: JSON.stringify(body),
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const {
    certRoot, scenario, mode, out, provider, imageFile, imageWidth, imageHeight, caseId, timeoutMs,
    candidateVersion, overlayFile,
  } = parseArgs(denoRuntime.args);
  const envKeys = installEnv(provider);
  installServeInterceptor();
  // Loaded and hash-verified BEFORE the certified entry is imported, so a bad
  // overlay stops the run before anything is dispatched.
  if (overlayFile) candidateOverlay = await loadOverlay(overlayFile, candidateVersion);
  if (provider === 'live' || provider === 'count-tokens') {
    const routingUrl = new URL(
      `file:///${certRoot.replace(/\\/g, '/').replace(/^\/+/, '')}/supabase/functions/_shared/llmModelRouting.ts`
    ).href;
    const routing = await import(routingUrl);
    if (provider === 'live') {
      installLiveFetchInterceptor(timeoutMs, routing.classifyProviderHttpFailure);
    } else {
      installCountTokensInterceptor(routing.SCANNER_PRIMARY_MODEL, routing.SCANNER_FALLBACK_MODEL);
    }
  }
  else installFetchInterceptor(scenario);

  const entryUrl = new URL(
    `file:///${certRoot.replace(/\\/g, '/').replace(/^\/+/, '')}/supabase/functions/scan-identify/index.ts`
  ).href;

  await import(entryUrl);

  if (!capturedHandler) {
    throw new Error('certified entry did not register a handler via Deno.serve');
  }

  const image =
    imageFile
      ? { base64: base64OfFile(imageFile), width: imageWidth, height: imageHeight }
      : undefined;

  const request = await buildV2Request(mode, image);
  let status = 0;
  let payload: unknown = null;
  let handlerError: string | null = null;
  const handlerStarted = performance.now();

  let countTokensError: string | null = null;
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
    if (provider === 'count-tokens' && error instanceof CountTokensCaptured) {
      // Expected control flow: both real countTokens calls already completed
      // inside the interceptor before it aborted the certified handler. Nothing
      // failed.
    } else if (provider === 'count-tokens') {
      // Arbitrary exception text may include a request URL or a status body.
      // Only a fixed sentinel may cross the harness boundary.
      void error;
      countTokensError = 'count_tokens_failed';
    } else {
      // Arbitrary exception text may include a request URL. The Gemini URL carries
      // its credential in the query string, so only a fixed sentinel may cross the
      // harness boundary.
      void error;
      handlerError = 'certified_handler_failed';
    }
  }

  if (provider === 'count-tokens') {
    // Dedicated, minimal report. No V2 result exists for this mode, and the
    // captured request body (prompt text, image bytes) was already discarded
    // inside the interceptor — only the two integer counts survive.
    const countReport = JSON.stringify(
      {
        provider,
        caseId,
        candidateVersion,
        ok: countTokensError === null && tokenCounts.primary !== null && tokenCounts.fallback !== null,
        error: countTokensError,
        primaryInputTokens: tokenCounts.primary,
        fallbackInputTokens: tokenCounts.fallback,
        // Cache-identity hashes only (see installCountTokensInterceptor). Never
        // the prompt or image bytes themselves.
        serializedRequestPayloadSha256: tokenCounts.serializedRequestPayloadSha256,
        promptSha256: tokenCounts.promptSha256,
        generationConfigSha256: tokenCounts.generationConfigSha256,
        systemInstructionSha256: ABSENT_FIELD_SHA256,
        toolDeclarationsSha256: ABSENT_FIELD_SHA256,
      },
      null,
      2
    );
    if (out) await denoRuntime.writeTextFile(out, `${countReport}\n`);
    else console.log(countReport);
    return;
  }

  // The certified response carries the V2 result nested under
  // `identificationV2` alongside the legacy projection, not at the top level.
  const handlerLatencyMs = performance.now() - handlerStarted;
  const result = payload as Json | null;
  const v2 = (result?.identificationV2 ?? null) as Json | null;
  const report = JSON.stringify(
      {
        scenario,
        mode,
        provider,
        caseId,
        // Which execution produced this report. Recorded as ids and a hash only —
        // the overlay TEXT is never emitted, so a report cannot become a second,
        // unhashed copy of the instruction artifact.
        candidateVersion,
        overlayId: candidateOverlay ? candidateOverlay.overlayId : null,
        overlaySha256: candidateOverlay ? candidateOverlay.textSha256 : null,
        overlayApplications,
        handlerLatencyMs,
        // Per-attempt telemetry: model, status, latency and token counts only.
        providerAttempts,
        attemptCount: provider === 'live' ? providerAttempts.length : counters.modelCalls,
        certRootAccepted: true,
        httpStatus: status,
        handlerError,
        // Redacted environment: names only, never values.
        envVarNames: envKeys,
        legacyStatus: result?.status ?? null,
        v2Present: Boolean(v2),
        // The full parsed V2 object is the scoring input. It is structured
        // certified output, not the raw provider envelope; prompts, image bytes
        // and candidate text remain absent from the report.
        observed: v2,
        counters,
        modelsUsed,
        blockedHosts,
        // MOCK ONLY. The mock body was constructed by this harness from synthetic
        // values, so it cannot contain user data and is safe to surface.
        //
        // In LIVE mode the payload is model-generated and is deliberately NOT
        // emitted: the private boundary permits the parsed structured result
        // (`observed`) but not the full raw provider response. Dropping it here
        // means it is never written to disk in the first place, rather than being
        // written and redacted afterwards.
        rawPayload: provider === 'live' ? undefined : result,
      },
      null,
      2
    );

  if (out) await denoRuntime.writeTextFile(out, `${report}\n`);
  else console.log(report);
}

await main();
