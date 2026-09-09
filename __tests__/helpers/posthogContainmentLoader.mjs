/**
 * ESM loader hooks that replace `posthog-react-native` with a stub that
 * BEHAVES LIKE A LIVE CLIENT.
 *
 * WHY THE STUB IS NOISY: a stub whose constructor does nothing would make
 * "no network egress" and "no polling started" pass for free — the assertions
 * would hold even if the wrapper constructed a client on every malformed
 * config, which is exactly the defect under test. So on construction this
 * stub does what the real SDK does: opens a flush interval and sends a
 * request to the configured host. Containment is then a real claim — if the
 * wrapper ever constructs a client, the probe's network and timer spies fire
 * and the test fails.
 *
 * The request goes through the probe's short-circuited `fetch` spy, so it is
 * recorded and never leaves the machine. No real PostHog endpoint is ever
 * contacted by this suite.
 *
 * WHY A LOADER AND NOT A `require` MOCK: services/analytics/
 * posthogClient.core.ts is an ES module, so its specifiers never pass through
 * CommonJS `Module._load` and cannot be intercepted via `require.cache`. The
 * loader also means the probe never needs the real vendor package to be
 * loadable — `posthog-react-native` requires `react-native` at top level and
 * cannot be imported under plain `node --test`.
 */

const STUB_URL = 'posthog-containment-stub:posthog-react-native';

const STUB_SOURCE = `
const spy = (globalThis.__POSTHOG_CONTAINMENT_SPY__ ??= { calls: [] });
const record = (op, detail) => spy.calls.push({ op, ...detail });

export default class PostHog {
  constructor(apiKey, options) {
    record('construct', { apiKey, options });
    // Mirror the real client: a live client starts its own flush loop and
    // talks to the host without waiting for the app to call capture().
    this._flushTimer = setInterval(() => this.flush(), 10000);
    const host = (options && options.host) || '';
    try {
      void fetch(host + '/batch/', { method: 'POST', body: '{}' });
    } catch {
      /* the probe's fetch spy short-circuits; never a real request */
    }
  }
  capture(event, properties) { record('capture', { event, properties }); }
  identify(distinctId) { record('identify', { distinctId }); }
  reset() { record('reset', {}); }
  flush() { record('flush', {}); }
  optIn() { record('optIn', {}); }
  optOut() { record('optOut', {}); }
  register() { record('register', {}); }
  screen(name) { record('screen', { name }); }
  alias(alias) { record('alias', { alias }); }
  getFeatureFlag(key) { record('getFeatureFlag', { key }); return undefined; }
  reloadFeatureFlags() { record('reloadFeatureFlags', {}); }
  shutdown() { record('shutdown', {}); }
}

export function PostHogProvider() {
  return null;
}
`;

export async function resolve(specifier, context, next) {
  if (specifier === 'posthog-react-native') {
    return { url: STUB_URL, shortCircuit: true, format: 'module' };
  }
  try {
    return await next(specifier, context);
  } catch (err) {
    // The wrapper and its sinks import each other extensionlessly
    // (`./posthogIdentitySync`). Bare ESM resolution does not try `.ts`, so
    // recover the way the app's bundler would.
    const recoverable =
      err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT';
    if (recoverable && /^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
      return await next(`${specifier}.ts`, context);
    }
    throw err;
  }
}

export async function load(url, context, next) {
  if (url === STUB_URL) {
    return { format: 'module', shortCircuit: true, source: STUB_SOURCE };
  }
  return next(url, context);
}
