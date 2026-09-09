/**
 * Drives a scripted authentication lifecycle through the REAL PostHog
 * adapter and reports every call the vendor SDK received, arguments
 * included.
 *
 * CRITICAL: this probe runs with PostHog CONFIGURED (a valid key and https
 * host). Proving "no identify" against a disabled client would be vacuous —
 * PH35-R1 already guarantees a disabled client makes no calls at all. The
 * claim here is the stronger one: even when PostHog is fully live, no K Scan
 * authenticated identifier ever reaches it.
 *
 * The vendor is the same noisy stub the PH35-R1 containment suite uses
 * (helpers/posthogContainmentLoader.mjs), which records identify/alias/group/
 * capture/reset/... So an identify would be recorded with its argument, and
 * the test scans the whole serialized call log for forbidden values.
 *
 * Lifecycle steps arrive as JSON on argv[3]; each is one of:
 *   { op: 'sync', authenticated: boolean }   - auth boundary moved
 *   { op: 'reset' }                          - explicit adapter reset
 *   { op: 'bridge' }                         - wire the telemetry sinks
 *   { op: 'emit' }                           - a bounded product event
 */

import { pathToFileURL } from 'node:url';

globalThis.__POSTHOG_CONTAINMENT_SPY__ = { calls: [] };

// A live client opens a flush interval. Unref it, or this probe never exits.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle?.unref?.();
  return handle;
};

// The fetch the stubbed client uses on construction. Recorded, never sent.
const sent = [];
globalThis.fetch = (input) => {
  sent.push(String(input));
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
};

const [, , corePath, stepsJson] = process.argv;
const coreUrl = pathToFileURL(corePath);
const steps = JSON.parse(stepsJson);

const errors = [];
const core = await import(coreUrl.href);

const closet = await import(new URL('../../services/closetTelemetry.ts', coreUrl).href);

for (const step of steps) {
  try {
    switch (step.op) {
      case 'sync':
        if (typeof core.syncPostHogAnonymousIdentity === 'function') {
          core.syncPostHogAnonymousIdentity(step.authenticated);
        } else if (typeof core.syncPostHogIdentity === 'function') {
          // Pre-repair adapter. Drive it the way app/_layout.tsx used to, so
          // the negative control exercises the REAL old bridge with a REAL
          // user id rather than merely noticing the export is missing.
          core.syncPostHogIdentity(step.authenticated ? step.userId : null);
        } else {
          errors.push('no identity sync export found');
        }
        break;
      case 'reset':
        core.resetPostHogUser();
        break;
      case 'bridge':
        core.bridgeAllTelemetrySinks();
        break;
      case 'emit':
        closet.emitClosetCandidateEvent('closet_candidate_created', { sourceType: 'camera' });
        break;
      default:
        errors.push(`unknown step ${step.op}`);
    }
  } catch (err) {
    // A throw here would mean analytics can break an auth lifecycle call.
    errors.push(`${step.op} threw: ${err?.message ?? err}`);
  }
}

process.stdout.write(
  JSON.stringify({
    errors,
    clientCreated: core.posthog !== null,
    // Every identity-shaped export the adapter still offers.
    exportedNames: Object.keys(core).sort(),
    calls: globalThis.__POSTHOG_CONTAINMENT_SPY__.calls,
    // Full serialized surface, for sentinel scanning.
    serialized: JSON.stringify(globalThis.__POSTHOG_CONTAINMENT_SPY__.calls),
    networkTargets: sent,
  }),
);
