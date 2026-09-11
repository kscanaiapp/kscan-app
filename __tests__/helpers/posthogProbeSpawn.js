/**
 * Shared child-process invocation for the PostHog probe suites.
 *
 * WHY THIS EXISTS: the three probe suites (disabled-state containment,
 * anonymous identity, governed boundary) each spawned Node with
 * `--import <absolute filesystem path>`. Node resolves the `--import` value
 * as a URL, not as a path. On POSIX an absolute path (`/home/u/x.mjs`) has no
 * scheme, so it is parsed as a relative URL and resolved against the cwd and
 * the child starts. On Windows the same value is `C:\src\...\x.mjs`, whose
 * leading `C:` parses as a URL scheme, and the loader rejects it:
 *
 *   Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in:
 *   file, data, and node are supported by the default ESM loader.
 *   Received protocol 'c:'
 *
 * Every spawned probe then exited non-zero, and every assertion that reads the
 * probe's stdout failed — on Windows only, for a reason that had nothing to do
 * with PostHog. The suites were untrustworthy on that platform while appearing
 * green everywhere else.
 *
 * THE REPAIR: hand the ESM loader a real `file:` URL built by
 * `pathToFileURL`, which is the standards-correct representation of a local
 * path as a module specifier. It percent-encodes what a URL must encode
 * (spaces, `#`, `?`, non-ASCII) and emits `file:///C:/...` for drive paths, so
 * it is correct for POSIX paths, Windows drive paths, UNC paths, and paths
 * containing characters that would otherwise be parsed as URL syntax.
 *
 * The probe script and its arguments are NOT converted: Node resolves the
 * entry-point positional argument as a filesystem path, where a raw absolute
 * path is already correct on every platform.
 *
 * Centralising this here means the three suites share one invocation and the
 * defect cannot be reintroduced in one file and missed in the others. Nothing
 * about what the probes assert changes — same tests, same assertions, same
 * negative controls, on every platform.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const HELPERS_DIR = __dirname;
const ROOT = path.join(HELPERS_DIR, '..', '..');

/** The module that registers the containment stub loader in the child. */
const REGISTER_PATH = path.join(HELPERS_DIR, 'posthogContainmentRegister.mjs');

/** The real wrapper under test. Probes turn this into a URL themselves. */
const CORE_PATH = path.join(ROOT, 'services', 'analytics', 'posthogClient.core.ts');

/**
 * Convert a local filesystem path into a specifier the ESM loader accepts.
 *
 * Exported so the cross-platform regression test can pin the conversion
 * directly against Windows-shaped input without needing a Windows runner.
 */
function toEsmImportSpecifier(filePath) {
  return pathToFileURL(filePath).href;
}

/** Argv for a probe child: loader registration, then the probe and its args. */
function probeArgv(probePath, ...probeArgs) {
  return ['--import', toEsmImportSpecifier(REGISTER_PATH), probePath, CORE_PATH, ...probeArgs];
}

/** Spawn a probe under `env` and return the raw spawnSync result. */
function runProbeProcess(probePath, probeArgs, env) {
  return spawnSync(process.execPath, probeArgv(probePath, ...probeArgs), {
    encoding: 'utf8',
    env,
  });
}

module.exports = {
  CORE_PATH,
  REGISTER_PATH,
  probeArgv,
  runProbeProcess,
  toEsmImportSpecifier,
};
