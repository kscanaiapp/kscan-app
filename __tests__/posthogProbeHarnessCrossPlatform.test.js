// PH35-H1 — the PostHog probe harness must start its child on every platform.
//
// THE DEFECT THIS PINS: the three PostHog probe suites spawn a child with
// `node --import <module> <probe> ...`. They passed an absolute FILESYSTEM
// PATH as the `--import` value. Node resolves that value as a URL, not as a
// path:
//
//   POSIX    /home/u/x.mjs    no scheme -> parsed relative, resolved -> works
//   Windows  C:\src\x.mjs     `C:` parses as a scheme -> loader rejects it
//
// so on Windows every probe child died before running a line of probe code
// with ERR_UNSUPPORTED_ESM_URL_SCHEME, every `assert.equal(result.status, 0)`
// failed, and ~66 PostHog assertions failed for a reason with nothing to do
// with PostHog. Green on Linux and CI, red on every Windows workstation.
//
// WHY THIS TEST IS NOT PLATFORM-LOCKED: the loader's URL parsing is the same
// code on every platform. A drive-letter specifier is rejected on Linux and
// macOS exactly as it is on Windows — the only thing Windows changes is that
// `path.join` PRODUCES such a value. So this file drives Windows-shaped input
// through a real child process on whatever platform it runs on, and gets the
// Windows failure mode without a Windows runner.
//
// The first test is the negative control: it asserts the ORIGINAL raw-path
// construction still fails, so the second test's pass is evidence of the
// repair and not of a loader that stopped caring.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  REGISTER_PATH,
  probeArgv,
  toEsmImportSpecifier,
} = require('./helpers/posthogProbeSpawn.js');

/** Spawn `node --import <specifier> -e ...` and report what happened. */
function importSpecifier(specifier) {
  return spawnSync(process.execPath, ['--import', specifier, '-e', 'console.log("started")'], {
    encoding: 'utf8',
  });
}

test('negative control: a raw Windows path as --import is rejected by the ESM loader', () => {
  // Exactly what `path.join(__dirname, 'helpers', '...')` returns on Windows.
  const rawWindowsPath = path.win32.join(
    'C:\\src\\KScan\\__tests__',
    'helpers',
    'posthogContainmentRegister.mjs',
  );
  assert.match(rawWindowsPath, /^C:\\/, 'the control input must be a drive-letter path');

  const result = importSpecifier(rawWindowsPath);

  assert.notEqual(result.status, 0, 'a raw drive-letter path must not be accepted as a specifier');
  assert.match(
    result.stderr,
    /ERR_UNSUPPORTED_ESM_URL_SCHEME/,
    `expected the drive-letter scheme rejection, got:\n${result.stderr}`,
  );
});

test('in file URL form the drive letter is path, not scheme, and clears the loader', () => {
  // The repair must not merely avoid the error — the drive letter has to end
  // up INSIDE the URL path (`file:///C:/...`), where the loader reads it as a
  // filename, rather than in front of the colon where it reads as a scheme.
  //
  // Off Windows there is no C: drive to open, so the child cannot start. What
  // matters is HOW it fails: reaching "module not found" means the specifier
  // was accepted and resolved as a file path. Reaching the scheme rejection
  // would mean the drive letter is still being read as a protocol.
  const result = importSpecifier('file:///C:/src/KScan/__tests__/helpers/does-not-exist.mjs');

  assert.doesNotMatch(
    result.stderr,
    /ERR_UNSUPPORTED_ESM_URL_SCHEME/,
    'a drive letter inside a file URL must never be parsed as a scheme',
  );
  if (process.platform !== 'win32') {
    assert.match(
      result.stderr,
      /ERR_MODULE_NOT_FOUND/,
      `expected path resolution to be attempted, got:\n${result.stderr}`,
    );
  }
});

test('the harness hands the loader a file: URL, not a filesystem path', () => {
  const [flag, specifier] = probeArgv('/probe.mjs');

  assert.equal(flag, '--import');
  assert.ok(specifier.startsWith('file://'), `--import specifier must be a file URL, got ${specifier}`);
  assert.notEqual(specifier, REGISTER_PATH, 'the raw path must not be passed through');
  assert.equal(
    fs.realpathSync(new URL(specifier)),
    fs.realpathSync(REGISTER_PATH),
    'the file URL must still resolve to the register module',
  );
});

test('the repaired specifier actually starts a child on this platform', () => {
  const result = importSpecifier(toEsmImportSpecifier(REGISTER_PATH));

  assert.equal(
    result.status,
    0,
    `--import of the register module must start the child\nstderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /started/);
});

test('the specifier survives spaces and URL-significant characters in the path', () => {
  // A checkout under `C:\Users\Ada Lovelace\src` or a path containing `#`
  // must not truncate or mis-resolve. Manual string concatenation of
  // `file://` + path gets this wrong; pathToFileURL percent-encodes it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog probe#dir-'));
  try {
    const file = path.join(dir, 'register probe.mjs');
    fs.writeFileSync(file, 'console.log("loaded");\n');

    const specifier = toEsmImportSpecifier(file);
    assert.ok(!specifier.includes(' '), 'a space must be percent-encoded, not left raw');
    assert.ok(!specifier.includes('#'), 'a fragment character must be percent-encoded');
    assert.equal(fs.realpathSync(new URL(specifier)), fs.realpathSync(file));

    const result = importSpecifier(specifier);
    assert.equal(result.status, 0, `child must start from an awkward path\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /loaded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
