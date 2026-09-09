/**
 * Loads the real PostHog wrapper under one configuration, drives every route
 * that could reach the vendor, and reports what actually happened at the
 * vendor boundary AND at the process boundary.
 *
 * Two independent layers of evidence:
 *
 *   1. Vendor boundary — the stubbed SDK records construct/capture/identify/
 *      flush/... calls (helpers/posthogContainmentLoader.mjs).
 *   2. Process boundary — fetch/http/https/net/XHR/sendBeacon and timer
 *      creation are spied here, BEFORE the wrapper is imported. This is what
 *      makes NETWORK_EGRESS and POLLING_STARTED real assertions instead of
 *      restatements of layer 1: the stub deliberately opens a flush interval
 *      and sends a request when constructed, so a wrapper that constructs a
 *      client on a malformed config trips these spies.
 *
 * Every network spy RECORDS AND SHORT-CIRCUITS. Nothing in this suite ever
 * performs a real request, so no PostHog endpoint is contacted.
 *
 * Run as a child process (one per configuration case): the wrapper builds its
 * client once at module load from process.env, so a fresh process is the only
 * honest way to evaluate a different configuration.
 */

import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Captured before spying so the probe's own settle delay is never recorded
// as application polling.
const realSetTimeout = globalThis.setTimeout;

const egress = { fetch: 0, http: 0, https: 0, net: 0, xhr: 0, beacon: 0, targets: [] };
const timers = { intervals: [], timeouts: [] };

globalThis.__POSTHOG_CONTAINMENT_SPY__ = { calls: [] };

// ─── Network spies (record + short-circuit) ─────────────────────────────────

globalThis.fetch = (input, init) => {
  egress.fetch += 1;
  egress.targets.push(String(input));
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
};

function blockModuleRequest(mod, name, label) {
  const original = mod[name];
  if (typeof original !== 'function') return;
  mod[name] = (...args) => {
    egress[label] += 1;
    egress.targets.push(`${label}:${typeof args[0] === 'string' ? args[0] : '[options]'}`);
    throw new Error(`containment probe blocked ${label}.${name}`);
  };
}
blockModuleRequest(http, 'request', 'http');
blockModuleRequest(http, 'get', 'http');
blockModuleRequest(https, 'request', 'https');
blockModuleRequest(https, 'get', 'https');
blockModuleRequest(net, 'connect', 'net');
blockModuleRequest(net, 'createConnection', 'net');

if (typeof globalThis.XMLHttpRequest === 'function') {
  globalThis.XMLHttpRequest = class {
    open() { egress.xhr += 1; }
    send() {}
    setRequestHeader() {}
  };
}
if (globalThis.navigator && typeof globalThis.navigator.sendBeacon === 'function') {
  globalThis.navigator.sendBeacon = () => {
    egress.beacon += 1;
    return true;
  };
}

// ─── Timer spies (record; unref so a stray loop cannot hang the probe) ──────

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  timers.intervals.push({ ms: ms ?? 0 });
  const handle = realSetInterval(fn, ms, ...rest);
  handle?.unref?.();
  return handle;
};
globalThis.setTimeout = (fn, ms, ...rest) => {
  timers.timeouts.push({ ms: ms ?? 0 });
  const handle = realSetTimeout(fn, ms, ...rest);
  handle?.unref?.();
  return handle;
};

// ─── Load the real wrapper and drive every route to the vendor ──────────────

const [, , corePath] = process.argv;
const coreUrl = pathToFileURL(corePath);

let loadError = null;
let core = null;
try {
  core = await import(coreUrl.href);
} catch (err) {
  loadError = err?.message ?? String(err);
}

if (core) {
  const call = (fn) => {
    try {
      fn();
    } catch (err) {
      // A throw here is itself a containment failure (product behaviour must
      // survive an absent/invalid PostHog), so it is reported, not swallowed.
      loadError = loadError ?? `exercise threw: ${err?.message ?? err}`;
    }
  };

  call(() => core.bridgeAllTelemetrySinks());
  call(() => core.forwardTelemetryToPostHog('containment_probe_event', { probe: 'direct' }));
  call(() => core.identifyPostHogUser('containment-probe-user'));
  call(() => core.resetPostHogUser());
  call(() => core.syncPostHogIdentity('containment-probe-user'));
  call(() => core.syncPostHogIdentity(null));

  // The five bridged sinks, via their real emit functions — the path a
  // shipped feature actually takes.
  const rel = (p) => new URL(p, coreUrl).href;
  const [closet, kplus, today, voice, vto] = await Promise.all([
    import(rel('../../services/closetTelemetry.ts')),
    import(rel('../../services/kplus/kplusTelemetry.ts')),
    import(rel('../../services/todayWithElise/analytics.ts')),
    import(rel('../../services/voice/voiceTelemetry.ts')),
    import(rel('../../services/vto/vtoTelemetry.ts')),
  ]);

  call(() => closet.emitClosetCandidateEvent('closet_candidate_created', { sourceType: 'camera' }));
  call(() => kplus.emitKPlusEvent('kplus_feature_exposed', { source: 'closet' }));
  call(() => today.emitTodayWithEliseEvent('today_with_elise_impression', { priority: 'high' }));
  call(() => voice.emitVoiceEvent('voice_submit', { surface: 'scanner' }));
  call(() => vto.emitVtoEvent('vto_entry_tap', { origin: 'closet' }));
}

// Let any deferred/async flush land before reporting.
await new Promise((resolve) => realSetTimeout(resolve, 50));

const calls = globalThis.__POSTHOG_CONTAINMENT_SPY__.calls;
const opsSeen = (op) => calls.some((c) => c.op === op);

process.stdout.write(
  JSON.stringify({
    loadError,
    configured: core ? core.isPostHogConfigured() : null,
    clientCreated: core ? core.posthog !== null : null,
    vendorConstructed: opsSeen('construct'),
    captureCalled: opsSeen('capture'),
    identifyCalled: opsSeen('identify'),
    flushCalled: opsSeen('flush'),
    pollingStarted: timers.intervals.length > 0,
    networkEgressTotal:
      egress.fetch + egress.http + egress.https + egress.net + egress.xhr + egress.beacon,
    egress,
    timers,
    vendorCalls: calls.map((c) => c.op),
  }),
);
