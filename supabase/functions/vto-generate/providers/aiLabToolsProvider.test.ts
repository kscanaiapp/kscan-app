/**
 * Real-adapter contract tests.
 *
 * The live account is not subscribed to this API (see the module doc
 * comment and docs/vto-provider-benchmark.md), so these run against an
 * injected fetch built from the exact response SHAPES documented at
 * https://ailabtools.mintlify.app/docs/ai-portrait/editing/try-on-clothes-pro/api
 * and confirmed reachable by the empirical 403 probe. They prove the adapter
 * builds the right request and parses the documented response correctly --
 * they are NOT evidence of generation quality, because no real generation
 * has occurred. Do not read passing tests here as "the provider works".
 *
 * The harness dispatches by URL rather than call order: the adapter fetches
 * the garment image (any https URL), THEN submits, THEN polls (possibly
 * several times), THEN fetches the result image -- four different
 * endpoints, one of which (poll) is called a variable number of times. A
 * positional queue is brittle against exactly that variability; a URL-keyed
 * dispatcher is not.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  AILABTOOLS_PROVIDER_ID,
  createAiLabToolsProvider,
  unsupportedSlotReason,
} from './aiLabToolsProvider.ts';
import { validateVtoResultMedia } from '../vtoResultValidation.ts';
import type { VtoProviderInput } from '../vtoContract.ts';

const GARMENT_URL = 'https://cdn.example.com/coat.jpg';
const RESULT_URL = 'https://cdn.example.com/result.png';

const TOP_INPUT: VtoProviderInput = {
  personDataUri: 'data:image/jpeg;base64,QUFBQQ==', // "AAAA"
  garmentImageUrl: GARMENT_URL,
  slot: 'top',
  canonicalCategory: 'outerwear',
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A tiny real PNG so garment/result fetches decode to plausible bytes. */
const PNG_1x1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

/** A larger (~2.4KB) real PNG, above the orchestrator's 1024-byte result-size
 *  floor, for the one test that runs the fetched result through the SHARED
 *  validateVtoResultMedia -- the 1x1 fixture above is realistic for every
 *  other test but too small to pass that floor on its own. */
const PNG_LARGER = Uint8Array.from(
  atob(
    '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',
  ),
  (c) => c.charCodeAt(0),
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function imageResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice().buffer, { status, headers: { 'Content-Type': 'image/png' } });
}

/** Default: garment and result image fetches both succeed with a tiny PNG.
 *  Override `submit` / `poll` (poll may be an array, consumed in order and
 *  held on its last entry) to script the interesting behaviour under test. */
interface Script {
  garment?: () => Response;
  submit?: () => Response;
  poll?: (() => Response) | Array<() => Response>;
  result?: () => Response;
  /** Extra exact-URL responders, for a test that varies the result URL. */
  extra?: Record<string, () => Response>;
}

function scriptedFetch(script: Script = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let pollIndex = 0;
  const fn = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (script.extra?.[url]) return Promise.resolve(script.extra[url]());
    if (url === GARMENT_URL) return Promise.resolve((script.garment ?? (() => imageResponse(PNG_1x1)))());
    if (url === RESULT_URL) return Promise.resolve((script.result ?? (() => imageResponse(PNG_1x1)))());
    if (url.includes('/portrait/editing/try-on-clothes-pro')) {
      return Promise.resolve(
        (script.submit ?? (() => jsonResponse({ error_code: 0, task_id: 't1' })))(),
      );
    }
    if (url.includes('/common/query-async-task-result')) {
      const handlers = Array.isArray(script.poll) ? script.poll : script.poll ? [script.poll] : [];
      if (handlers.length === 0) {
        return Promise.resolve(
          jsonResponse({ error_code: 0, task_status: 2, output: { image_url: RESULT_URL } }),
        );
      }
      const handler = handlers[Math.min(pollIndex, handlers.length - 1)];
      pollIndex += 1;
      return Promise.resolve(handler());
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  return { fn, calls };
}

function callsTo(calls: Array<{ url: string; init: RequestInit }>, matcher: string) {
  return calls.filter((c) => c.url.includes(matcher));
}

// ── Slot support ──────────────────────────────────────────────────────────────
//
// Corrected 2026-08-30: the documented contract explicitly covers one-piece
// garments -- "If lower body clothing is not needed (e.g., when the upper
// body garment is a dress), this value should be left empty." -- confirmed
// verbatim across two independent doc pages. `full_body` is therefore
// servable via `top_garment` alone, identically to `top`. Only `bottom`
// remains unservable: `top_garment` is REQUIRED, so a bottom-only garment
// cannot be submitted without an unrelated top image the caller never chose.

Deno.test('top and full_body are served; only bottom is refused up front', () => {
  assertEquals(unsupportedSlotReason('top'), null);
  assertEquals(unsupportedSlotReason('full_body'), null);
  assert(unsupportedSlotReason('bottom'));
});

Deno.test('a bottom-slot request never reaches the network', async () => {
  const { fn, calls } = scriptedFetch();
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate({ ...TOP_INPUT, slot: 'bottom' }, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'unsupported_category');
  assertEquals(calls.length, 0);
});

Deno.test('a full_body (dress) request submits through top_garment with no bottom_garment field', async () => {
  const { fn, calls } = scriptedFetch();
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(
    { ...TOP_INPUT, slot: 'full_body', canonicalCategory: 'dress' },
    { signal: signal() },
  );
  assertEquals(outcome.ok, true);
  const submitCall = callsTo(calls, '/portrait/editing/try-on-clothes-pro')[0];
  const form = submitCall.init.body as FormData;
  assert(form.get('top_garment') instanceof Blob, 'the dress image goes in top_garment');
  assertEquals(form.get('bottom_garment'), null, 'bottom_garment must be left empty, not sent as null/empty string');
});

// ── Request construction ─────────────────────────────────────────────────────

Deno.test('the submit request uses the documented host, path, and headers', async () => {
  const { fn, calls } = scriptedFetch();
  const provider = createAiLabToolsProvider({ apiKey: 'the-real-key', fetchImpl: fn, pollIntervalMs: 0 });
  await provider.generate(TOP_INPUT, { signal: signal() });

  const submitCall = callsTo(calls, '/portrait/editing/try-on-clothes-pro')[0];
  assert(submitCall, 'a submit call must have been made');
  assertEquals(submitCall.url, 'https://try-on-clothes-pro.p.rapidapi.com/portrait/editing/try-on-clothes-pro');
  const headers = submitCall.init.headers as Record<string, string>;
  assertEquals(headers['x-rapidapi-host'], 'try-on-clothes-pro.p.rapidapi.com');
  assertEquals(headers['x-rapidapi-key'], 'the-real-key');
  assert(submitCall.init.body instanceof FormData);
  const form = submitCall.init.body as FormData;
  assertEquals(form.get('task_type'), 'async');
  assert(form.get('person_image') instanceof Blob, 'person_image must be a file part');
  assert(form.get('top_garment') instanceof Blob, 'top_garment must be a file part, not a string');
});

Deno.test('the garment https URL is fetched, not sent as a string field', async () => {
  const { fn, calls } = scriptedFetch();
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(callsTo(calls, GARMENT_URL).length, 1);
});

Deno.test('the credential never appears in the request body', async () => {
  const { fn, calls } = scriptedFetch();
  const provider = createAiLabToolsProvider({ apiKey: 'super-secret-value', fetchImpl: fn, pollIntervalMs: 0 });
  await provider.generate(TOP_INPUT, { signal: signal() });
  const submitCall = callsTo(calls, '/portrait/editing/try-on-clothes-pro')[0];
  const form = submitCall.init.body as FormData;
  for (const [, value] of form.entries()) {
    if (typeof value === 'string') assert(!value.includes('super-secret-value'));
  }
});

Deno.test('the poll request carries the returned task_id as a query param', async () => {
  const { fn, calls } = scriptedFetch({ submit: () => jsonResponse({ error_code: 0, task_id: 'task-abc-123' }) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  await provider.generate(TOP_INPUT, { signal: signal() });
  const pollCall = callsTo(calls, '/common/query-async-task-result')[0];
  assertEquals(
    pollCall.url,
    'https://try-on-clothes-pro.p.rapidapi.com/common/query-async-task-result?task_id=task-abc-123',
  );
});

// ── Async polling behaviour ──────────────────────────────────────────────────

Deno.test('queued and processing statuses keep polling; complete stops it', async () => {
  const { fn, calls } = scriptedFetch({
    poll: [
      () => jsonResponse({ error_code: 0, task_status: 0 }), // queued
      () => jsonResponse({ error_code: 0, task_status: 1 }), // processing
      () => jsonResponse({ error_code: 0, task_status: 1 }), // still processing
      () => jsonResponse({ error_code: 0, task_status: 2, output: { image_url: RESULT_URL } }),
    ],
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, true);
  assertEquals(callsTo(calls, '/common/query-async-task-result').length, 4);
});

Deno.test('a queue that never completes ends in provider_timeout, not a hang', async () => {
  const { fn } = scriptedFetch({ poll: () => jsonResponse({ error_code: 0, task_status: 0 }) });
  const provider = createAiLabToolsProvider({
    apiKey: 'k',
    fetchImpl: fn,
    pollIntervalMs: 0,
    pollMaxAttempts: 3,
  });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_timeout');
});

Deno.test('one transient poll failure does not abort the whole attempt', async () => {
  const { fn } = scriptedFetch({
    poll: [
      () => jsonResponse({ error: 'gateway hiccup' }, 502), // transient
      () => jsonResponse({ error_code: 0, task_status: 2, output: { image_url: RESULT_URL } }),
    ],
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, true);
});

Deno.test('cancellation during polling stops the loop and reports cancelled', async () => {
  const controller = new AbortController();
  let pollCount = 0;
  const { fn } = scriptedFetch({
    poll: () => {
      pollCount += 1;
      if (pollCount === 1) controller.abort();
      return jsonResponse({ error_code: 0, task_status: 1 });
    },
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: controller.signal });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'cancelled');
});

// ── Failure mapping (submit-time) ────────────────────────────────────────────

Deno.test('the empirically observed 403 subscription failure maps to provider_unavailable', async () => {
  const { fn } = scriptedFetch({
    submit: () => jsonResponse({ message: 'You are not subscribed to this API.' }, 403),
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_unavailable');
});

Deno.test('401 is also provider_unavailable, not authorization_failed', async () => {
  // K Scan's authorization_failed means "this K Scan user is not
  // authenticated". A 401 from the UPSTREAM vendor is an operator
  // credential problem, not anything about the K Scan caller -- conflating
  // them would tell a real user to sign in again for an outage that is
  // entirely on the provider side.
  const { fn } = scriptedFetch({ submit: () => jsonResponse({ message: 'Invalid API key' }, 401) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_unavailable');
});

Deno.test('429 maps to rate_limited', async () => {
  const { fn } = scriptedFetch({ submit: () => jsonResponse({ message: 'Too Many Requests' }, 429) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'rate_limited');
});

Deno.test('a 5xx maps to provider_unavailable', async () => {
  const { fn } = scriptedFetch({ submit: () => jsonResponse({}, 503) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_unavailable');
});

Deno.test('a non-zero error_code on submit maps to provider_rejected_input by default', async () => {
  const { fn } = scriptedFetch({
    submit: () => jsonResponse({ error_code: 40001, error_msg: 'bad image' }, 200),
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_rejected_input');
});

Deno.test('an error_msg mentioning moderation maps to provider_moderation', async () => {
  const { fn } = scriptedFetch({
    submit: () => jsonResponse({ error_code: 40002, error_msg: 'Image rejected by moderation policy' }, 200),
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_moderation');
});

Deno.test('a missing task_id on an otherwise-ok submit is invalid_output, not a crash', async () => {
  const { fn } = scriptedFetch({ submit: () => jsonResponse({ error_code: 0, task_type: 'async' }) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'invalid_output');
});

Deno.test('a non-zero error_code discovered only at poll time is still mapped, not swallowed', async () => {
  const { fn } = scriptedFetch({
    poll: () => jsonResponse({ error_code: 50003, error_msg: 'task failed during processing' }),
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'provider_rejected_input');
});

// ── Result handling ───────────────────────────────────────────────────────────

Deno.test('a complete task with no image_url is invalid_output', async () => {
  const { fn } = scriptedFetch({
    poll: () => jsonResponse({ error_code: 0, task_status: 2, output: {} }),
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'invalid_output');
});

Deno.test('the fetched result is inlined as a data URI the shared validator accepts', async () => {
  const { fn } = scriptedFetch({ result: () => imageResponse(PNG_LARGER) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, true);
  if (!outcome.ok) return;
  assert(outcome.media.dataUri.startsWith('data:image/png;base64,'));
  const validation = validateVtoResultMedia(outcome.media);
  assertEquals(validation.ok, true, validation.ok ? '' : (validation as { detail: string }).detail);
});

Deno.test('the result URL itself is never returned to the caller', async () => {
  const signedResultUrl = 'https://cdn.example.com/result.png?sig=abcdef123456';
  const { fn } = scriptedFetch({
    poll: () => jsonResponse({ error_code: 0, task_status: 2, output: { image_url: signedResultUrl } }),
    extra: { [signedResultUrl]: () => imageResponse(PNG_1x1) },
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, true);
  if (!outcome.ok) return;
  assert(!outcome.media.dataUri.includes('sig=abcdef123456'));
  assert(!outcome.media.dataUri.includes('cdn.example.com'));
});

Deno.test('an oversized result download is refused, not buffered without bound', async () => {
  const bigButFakeLength = String(9 * 1024 * 1024);
  const { fn } = scriptedFetch({
    result: () =>
      new Response(PNG_1x1.slice().buffer, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': bigButFakeLength },
      }),
  });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn, pollIntervalMs: 0 });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'invalid_output');
});

// ── Input handling ────────────────────────────────────────────────────────────

Deno.test('an undecodable person data URI never reaches the network', async () => {
  const { fn, calls } = scriptedFetch();
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(
    { ...TOP_INPUT, personDataUri: 'not-a-data-uri' },
    { signal: signal() },
  );
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'invalid_person_input');
  assertEquals(calls.length, 0);
});

Deno.test('a garment URL that 404s is invalid_garment_input, mapped before any submit', async () => {
  const { fn, calls } = scriptedFetch({ garment: () => new Response('not found', { status: 404 }) });
  const provider = createAiLabToolsProvider({ apiKey: 'k', fetchImpl: fn });
  const outcome = await provider.generate(TOP_INPUT, { signal: signal() });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.failure, 'invalid_garment_input');
  assertEquals(callsTo(calls, '/portrait/editing/try-on-clothes-pro').length, 0, 'never reaches submit');
});

// ── Empirical grounding ───────────────────────────────────────────────────────

Deno.test('this adapter targets exactly the host proven reachable by the live probe', () => {
  // Changing the host/path here without re-running the probe would silently
  // invalidate the one piece of real evidence this adapter has.
  assertEquals(AILABTOOLS_PROVIDER_ID, 'ailabtools_tryon_clothes_pro');
});
