// Build fix — every local Expo module's podspec must never let a Tests/ file
// reach the production/archive target.
//
// WHY THIS EXISTS: EAS build b6c51552-263b-41ec-bca5-07a2a1351357 failed
// store-archive compilation with "no such module 'XCTest'" because
// kscan-pii-native's podspec `source_files = "**/*.{h,m,swift}"` was
// unscoped and swept up modules/kscan-pii-native/ios/Tests/*.swift into
// KScanPiiNative's own release Swift module — a target that (correctly)
// never links XCTest.framework. This test simulates CocoaPods' own glob
// resolution (source_files minus exclude_files, both relative to the
// podspec's directory) so a future edit that widens the glob, drops
// exclude_files, or adds a new test file outside Tests/ fails locally, on
// Windows, without needing Ruby/CocoaPods or an EAS build to discover it.
//
// Build 34 Voice Scan V1 added a second local module
// (modules/kscan-voice-native) with its own podspec, so this suite no
// longer hardcodes "exactly one podspec in the repo" -- it discovers every
// podspec and applies the same safety checks to each one. A future module
// is covered automatically; it does not need its own copy of this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..');

// glob returns native path separators on Windows; CocoaPods' own resolution
// is POSIX-style regardless of host OS, so every path is normalized to
// forward slashes before comparison.
const toPosix = (p) => p.split(path.sep).join('/');

function extractRubyStringAssignment(source, key) {
  const m = source.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

const podspecPaths = glob
  .sync('**/*.podspec', { cwd: ROOT, ignore: ['node_modules/**'], nodir: true })
  .map(toPosix)
  .sort();

test('at least the two known local-module podspecs are discovered (sanity check on the glob itself)', () => {
  assert.ok(podspecPaths.includes('modules/kscan-pii-native/ios/KScanPiiNative.podspec'));
  assert.ok(podspecPaths.includes('modules/kscan-voice-native/ios/KScanVoiceNative.podspec'));
});

for (const relativePodspecPath of podspecPaths) {
  const podspecFile = path.join(ROOT, relativePodspecPath);
  const moduleDir = path.dirname(podspecFile);
  const podspec = fs.readFileSync(podspecFile, 'utf8');

  test(`${relativePodspecPath}: declares source_files and exclude_files exactly as expected`, () => {
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

  test(`${relativePodspecPath}: isolates tests into their own test_spec, not deleted`, () => {
    assert.match(podspec, /s\.test_spec\s+'Tests'\s+do\s+\|test_spec\|/);
    assert.match(podspec, /test_spec\.source_files\s*=\s*"Tests\/\*\*\/\*\.swift"/);
    assert.match(podspec, /test_spec\.frameworks\s*=\s*'XCTest'/);
  });

  /**
   * Reproduces CocoaPods' own file-set resolution closely enough to catch
   * the exact class of regression that broke the archive build:
   * source_files and exclude_files are both globs relative to the
   * podspec's directory, and the effective set is (source_files matches)
   * minus (exclude_files matches).
   */
  function resolvePodspecSourceFiles() {
    const matches = glob.sync('**/*.{h,m,swift}', { cwd: moduleDir, nodir: true }).map(toPosix);
    const excluded = new Set(glob.sync('Tests/**/*', { cwd: moduleDir, nodir: true }).map(toPosix));
    return matches.filter((f) => !excluded.has(f));
  }

  test(`${relativePodspecPath}: the resolved production file set contains no file under Tests/`, () => {
    const resolved = resolvePodspecSourceFiles();
    assert.ok(resolved.length > 0, 'sanity: the module must still compile something');
    for (const file of resolved) {
      assert.ok(!file.startsWith('Tests/'), `${file} must not reach the production target`);
    }
  });

  test(`${relativePodspecPath}: the resolved production file set contains no file that imports XCTest`, () => {
    const resolved = resolvePodspecSourceFiles();
    for (const file of resolved) {
      const contents = fs.readFileSync(path.join(moduleDir, file), 'utf8');
      assert.doesNotMatch(
        contents,
        /^\s*import XCTest/m,
        `${file} imports XCTest but is reachable from the production target`,
      );
    }
  });

  test(`${relativePodspecPath}: every file that imports XCTest is captured by the Tests/ exclusion`, () => {
    const allSwiftFiles = glob.sync('**/*.swift', { cwd: moduleDir, nodir: true }).map(toPosix);
    const xctestFiles = allSwiftFiles.filter((f) =>
      /^\s*import XCTest/m.test(fs.readFileSync(path.join(moduleDir, f), 'utf8')),
    );
    for (const file of xctestFiles) {
      assert.ok(file.startsWith('Tests/'), `${file} imports XCTest but sits outside Tests/`);
    }
  });
}

test('kscan-pii-native still has its two known XCTest files (unchanged by this build)', () => {
  const moduleDir = path.join(ROOT, 'modules', 'kscan-pii-native', 'ios');
  const allSwiftFiles = glob.sync('**/*.swift', { cwd: moduleDir, nodir: true }).map(toPosix);
  const xctestFiles = allSwiftFiles.filter((f) =>
    /^\s*import XCTest/m.test(fs.readFileSync(path.join(moduleDir, f), 'utf8')),
  );
  assert.ok(xctestFiles.length >= 2, 'expected the two known XCTest files to still exist');
});
