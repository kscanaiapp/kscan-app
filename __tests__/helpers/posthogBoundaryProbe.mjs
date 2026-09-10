/**
 * Sends one (event, payload) pair through the REAL adapter with PostHog
 * configured, and reports exactly what the vendor SDK received.
 *
 * The assertions that matter are about the payload presented to the vendor,
 * not about what the boundary function returned in isolation — so this drives
 * `forwardTelemetryToPostHog`, the same reference the five bridged sinks are
 * handed, and reads the capture off the stubbed SDK.
 *
 * argv[3] is JSON: { event: unknown, payload: unknown }
 */

import { pathToFileURL } from 'node:url';

globalThis.__POSTHOG_CONTAINMENT_SPY__ = { calls: [] };

globalThis.fetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle?.unref?.();
  return handle;
};

const [, , corePath, spec] = process.argv;
const parsed = JSON.parse(spec);
const mode = parsed.mode ?? 'send';

/**
 * JSON cannot carry NaN or Infinity, so they travel as
 * { __number__: 'NaN' | 'Infinity' } and are rehydrated here.
 */
function rehydrate(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.__number__ === 'string') {
      return value.__number__ === 'NaN' ? Number.NaN : Number.POSITIVE_INFINITY;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rehydrate(v);
    return out;
  }
  return value;
}

const event = parsed.event;
const payload = rehydrate(parsed.payload);

const core = await import(pathToFileURL(corePath).href);
const coreDir = new URL('.', pathToFileURL(corePath));

// Introspection modes exist because these modules import the feature sinks
// extensionlessly (the repo's convention, resolved by Metro). Plain
// `node --test` cannot follow that, but this probe runs under the loader
// that can — so the test file itself stays free of `.ts` requires.
if (mode === 'registry') {
  const registry = await import(new URL('analyticsEventRegistry.ts', coreDir).href);
  process.stdout.write(
    JSON.stringify({
      size: registry.ANALYTICS_EVENT_REGISTRY.size,
      declared: registry.declaredAnalyticsEventNames(),
      contracts: registry.ANALYTICS_SURFACE_CONTRACTS.map((c) => ({
        surface: c.surface,
        owner: c.owner,
        eventCount: c.events.length,
        properties: [...c.properties],
        anonymousAllowed: c.anonymousAllowed,
        privacySensitivity: c.privacySensitivity,
        commerceSensitivity: c.commerceSensitivity,
      })),
      entries: [...registry.ANALYTICS_EVENT_REGISTRY.values()].map((e) => ({
        event: e.event,
        surface: e.surface,
        propertyCount: e.properties.size,
        anonymousAllowed: e.anonymousAllowed,
      })),
    }),
  );
  process.exit(0);
}

if (mode === 'boundary') {
  const boundary = await import(new URL('analyticsBoundary.ts', coreDir).href);
  const result = boundary.applyAnalyticsBoundary(event, payload);
  process.stdout.write(
    JSON.stringify({
      allowed: result.allowed,
      reason: result.reason ?? null,
      payload: result.payload,
      strippedKeys: result.strippedKeys,
    }),
  );
  process.exit(0);
}

let threw = null;
try {
  core.forwardTelemetryToPostHog(event, payload);
} catch (err) {
  threw = err?.message ?? String(err);
}

const captures = globalThis.__POSTHOG_CONTAINMENT_SPY__.calls.filter((c) => c.op === 'capture');

process.stdout.write(
  JSON.stringify({
    threw,
    clientCreated: core.posthog !== null,
    captureCount: captures.length,
    capturedEvent: captures[0]?.event ?? null,
    capturedProperties: captures[0]?.properties ?? null,
    serialized: JSON.stringify(captures),
  }),
);
