/**
 * ESM loader hooks that replace `posthog-react-native` with a recording stub.
 *
 * WHY A LOADER AND NOT A `require` MOCK: services/analytics/
 * posthogClient.core.ts is loaded as an ES module (it uses `import`), so its
 * specifiers never pass through CommonJS `Module._load` and cannot be
 * intercepted by seeding `require.cache`. A resolve/load hook is the only
 * seam that catches them.
 *
 * This also means the probe never needs the real vendor package on disk:
 * `posthog-react-native` expects a React Native runtime and cannot be
 * constructed under plain `node --test`, and node_modules may not even be
 * installed. The stub is returned before resolution reaches node_modules, so
 * the test exercises the REAL wrapper against a fake SDK — not a copy of the
 * wrapper's logic.
 *
 * The stub records into `globalThis.__POSTHOG_VENDOR_SPY__`. Hook code runs
 * on a separate thread, but the source returned by `load` is evaluated on the
 * main thread, so the probe can read the recording directly.
 */

const STUB_URL = 'posthog-vendor-stub:posthog-react-native';

const STUB_SOURCE = `
const spy = (globalThis.__POSTHOG_VENDOR_SPY__ ??= { events: [] });

export default class PostHog {
  constructor(apiKey, options) {
    spy.events.push({ op: 'construct', apiKey, options });
  }
  capture(event, properties) {
    spy.events.push({ op: 'capture', event, properties });
  }
  identify(distinctId) {
    spy.events.push({ op: 'identify', distinctId });
  }
  reset() {
    spy.events.push({ op: 'reset' });
  }
  flush() {
    spy.events.push({ op: 'flush' });
  }
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
