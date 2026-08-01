// Build fix — kscan-pii-native's podspec must never let a Tests/ file reach
// the production/archive target.
//
// WHY THIS EXISTS: EAS build b6c51552-263b-41ec-bca5-07a2a1351357 failed
// store-archive compilation with "no such module 'XCTest'" because the
// podspec's `source_files = "**/*.{h,m,swift}"` was unscoped and swept up
// modules/kscan-pii-native/ios/Tests/*.swift into KScanPiiNative's own
// release Swift module — a target that (correctly) never links
// XCTest.framework. This test simulates CocoaPods' own glob resolution
// (source_files minus exclude_files, both relative to the podspec's
// directory) so a future edit that widens the glob, drops exclude_files, or
// adds a new test file outside Tests/ fails locally, on Windows, without
// needing Ruby/CocoaPods or an EAS build to discover it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'modules', 'kscan-pii-native', 'ios');
const PODSPEC_PATH = path.join(MODULE_DIR, 'KScanPiiNative.podspec');
const podspec = fs.readFileSync(PODSPEC_PATH, 'utf8');

function extractRubyStringAssignment(source, key) {
  const m = source.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

test('podspec declares source_files and exclude_files exactly as expected', () => {
  const sourceFiles = extractRubyStringAssignment(podspec, 's\\.source_files');
  const excludeFiles = extractRubyStringAssignment(podspec, 's\\.exclude_files');
  assert.equal(sourceFiles, '**/*.{h,m,swift}');
  assert.equal(excludeFiles, 'Tests/**/*');
  // Must appear in this order: CocoaPods applies exclude_files as a filter
  // over source_files, but a human reading top-to-bottom should see the
  // exclusion adjacent to the broad glob it narrows.
  assert.ok(
    podspec.indexOf('s.exclude_files') > podspec.indexOf('s.source_files'),
    'exclude_files must be declared after source_files',
  );
});

test('podspec isolates the tests into their own test_spec, not deleted', () => {
  assert.match(podspec, /s\.test_spec\s+'Tests'\s+do\s+\|test_spec\|/);
  assert.match(podspec, /test_spec\.source_files\s*=\s*"Tests\/\*\*\/\*\.swift"/);
  assert.match(podspec, /test_spec\.frameworks\s*=\s*'XCTest'/);
});

/**
 * Reproduces CocoaPods' own file-set resolution closely enough to catch the
 * exact class of regression that broke the archive build: source_files and
 * exclude_files are both globs relative to the podspec's directory, and the
 * effective set is (source_files matches) minus (exclude_files matches).
 */
// glob returns native path separators on Windows; CocoaPods' own resolution
// is POSIX-style regardless of host OS, so every path is normalized to
// forward slashes before comparison.
const toPosix = (p) => p.split(path.sep).join('/');

function resolvePodspecSourceFiles() {
  const matches = glob.sync('**/*.{h,m,swift}', { cwd: MODULE_DIR, nodir: true }).map(toPosix);
  const excluded = new Set(
    glob.sync('Tests/**/*', { cwd: MODULE_DIR, nodir: true }).map(toPosix),
  );
  return matches.filter((f) => !excluded.has(f));
}

test('the resolved production file set contains no file under Tests/', () => {
  const resolved = resolvePodspecSourceFiles();
  assert.ok(resolved.length > 0, 'sanity: the module must still compile something');
  for (const file of resolved) {
    assert.ok(!file.startsWith('Tests/'), `${file} must not reach the production target`);
  }
});

test('the resolved production file set contains no file that imports XCTest', () => {
  const resolved = resolvePodspecSourceFiles();
  for (const file of resolved) {
    const contents = fs.readFileSync(path.join(MODULE_DIR, file), 'utf8');
    assert.doesNotMatch(
      contents,
      /^\s*import XCTest/m,
      `${file} imports XCTest but is reachable from the production target`,
    );
  }
});

test('every file that imports XCTest is captured by the Tests/ exclusion', () => {
  const allSwiftFiles = glob.sync('**/*.swift', { cwd: MODULE_DIR, nodir: true }).map(toPosix);
  const xctestFiles = allSwiftFiles.filter((f) =>
    /^\s*import XCTest/m.test(fs.readFileSync(path.join(MODULE_DIR, f), 'utf8')),
  );
  assert.ok(xctestFiles.length >= 2, 'expected the two known XCTest files to still exist');
  for (const file of xctestFiles) {
    assert.ok(file.startsWith('Tests/'), `${file} imports XCTest but sits outside Tests/`);
  }
});

test('no other podspec exists in the repository outside this module', () => {
  const podspecs = glob
    .sync('**/*.podspec', { cwd: ROOT, ignore: ['node_modules/**'], nodir: true })
    .map(toPosix);
  assert.deepEqual(podspecs, ['modules/kscan-pii-native/ios/KScanPiiNative.podspec']);
});
