'use strict';

/**
 * Test infrastructure: EXECUTE the REAL installed `expo-file-system` package.
 *
 * The question this exists to answer cannot be settled by reading an import
 * line: "does the object a caller obtains from `expo-file-system` (or from
 * `expo-file-system/legacy`) actually satisfy a legacy-shaped contract such as
 * `getInfoAsync(uri) -> { exists, size }`?". On SDK 54 the two specifiers
 * resolve to different code, and only running that code tells you which one
 * answers.
 *
 * What is REAL: every file under node_modules/expo-file-system that the two
 * public entry points load - `src/index.ts` (the package `main`),
 * `legacy.ts`, `src/legacy/*`, `src/legacyWarnings.ts`. They are transpiled
 * from the installed sources, so a future SDK bump changes what this harness
 * proves.
 *
 * What is FAKED: only the bare specifiers that reach a device -
 * `expo-modules-core` (the native bridge) and `react-native` (`Platform`) - plus
 * the native module those bridges return. An import the harness does not know
 * throws, so a new native dependency in the SDK is visible instead of silently
 * stubbed.
 *
 * It is a helper, not a test: scripts/run-all-tests.js discovers `*.test.js`
 * only.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_DIR = path.join(ROOT, 'node_modules', 'expo-file-system');

/** Representative app-container document roots. Only their shape matters. */
const DOCUMENT_DIRECTORIES = {
  ios: 'file:///var/mobile/Containers/Data/Application/11111111-2222-4333-8444-555555555555/Documents/',
  android: 'file:///data/user/0/com.kscan.ai/files/',
};

/**
 * An in-memory stand-in for the native `ExponentFileSystem` module.
 *
 * `files` maps a file:// URI to `{ size }`. `downloads` maps a URL to
 * `{ status, size }` for `downloadAsync`. `calls` records every native call so
 * a test can assert that something did NOT happen (no storage read, no
 * download).
 */
function createFakeNativeFileSystem(platformOS) {
  const files = new Map();
  const downloads = new Map();
  const calls = [];
  const documentDirectory = DOCUMENT_DIRECTORIES[platformOS];
  if (!documentDirectory) throw new Error(`unknown platform ${platformOS}`);

  const native = {
    documentDirectory,
    cacheDirectory: documentDirectory.replace(/Documents\/$|files\/$/, 'Caches/'),
    bundleDirectory: null,
    async getInfoAsync(uri) {
      calls.push(['getInfoAsync', uri]);
      // Native returns this shape for a missing item; size is present only on a
      // file that exists.
      if (!files.has(uri)) return { exists: false, isDirectory: false, uri };
      return {
        exists: true,
        isDirectory: false,
        uri,
        size: files.get(uri).size,
        modificationTime: 1_700_000_000,
      };
    },
    async makeDirectoryAsync(uri) {
      calls.push(['makeDirectoryAsync', uri]);
    },
    async deleteAsync(uri, options = {}) {
      calls.push(['deleteAsync', uri]);
      if (!files.has(uri) && !options.idempotent) throw new Error(`ENOENT ${uri}`);
      files.delete(uri);
    },
    async moveAsync({ from, to }) {
      calls.push(['moveAsync', from, to]);
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async downloadAsync(url, fileUri) {
      calls.push(['downloadAsync', url, fileUri]);
      const plan = downloads.get(url);
      if (!plan) return { uri: fileUri, status: 404, headers: {}, mimeType: null };
      if (plan.status === 200) files.set(fileUri, { size: plan.size });
      return { uri: fileUri, status: plan.status, headers: {}, mimeType: 'image/jpeg' };
    },
  };

  return {
    native,
    files,
    downloads,
    calls,
    documentDirectory,
    /** Put a file on the fake disk. `size` defaults to a plausible JPEG. */
    put(uri, size = 48_213) {
      files.set(uri, { size });
      return uri;
    },
    callsTo(name) {
      return calls.filter((call) => call[0] === name);
    },
  };
}

function resolveRelative(fromDir, specifier) {
  const base = path.resolve(fromDir, specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${fromDir}`);
}

/**
 * Load both public entry points of the installed package over one fake device.
 *
 * `main`   - what `import * as FileSystem from 'expo-file-system'` yields.
 * `legacy` - what `import * as FileSystem from 'expo-file-system/legacy'` yields.
 * `specifiers` - the same two, keyed by import specifier, ready to spread into
 *                a strict require map.
 */
function loadExpoFileSystemSdk({ platformOS = 'ios' } = {}) {
  if (!fs.existsSync(PACKAGE_DIR)) {
    throw new Error('expo-file-system is not installed - run npm ci before this test');
  }
  const device = createFakeNativeFileSystem(platformOS);
  const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));

  class NativeModule {}
  class UnavailabilityError extends Error {
    constructor(moduleName, propertyName) {
      super(`The method or property ${moduleName}.${propertyName} is not available on ${platformOS}`);
      this.code = 'ERR_UNAVAILABLE';
    }
  }
  // The modern (`FileSystem`) native module: classes the SDK extends at load.
  const modernNative = Object.assign(new NativeModule(), {
    FileSystemFile: class FileSystemFile {},
    FileSystemDirectory: class FileSystemDirectory {},
    documentDirectory: device.documentDirectory,
    cacheDirectory: device.native.cacheDirectory,
    bundleDirectory: null,
    totalDiskSpace: 0,
    availableDiskSpace: 0,
  });

  const bare = {
    'expo-modules-core': {
      NativeModule,
      UnavailabilityError,
      uuid: { v4: () => '00000000-0000-4000-8000-000000000000' },
      requireNativeModule(name) {
        if (name === 'FileSystem') return modernNative;
        throw new Error(`unexpected requireNativeModule(${name})`);
      },
      requireOptionalNativeModule(name) {
        return name === 'ExponentFileSystem' ? device.native : null;
      },
    },
    'react-native': { Platform: { OS: platformOS, select: (spec) => spec[platformOS] ?? spec.default } },
  };

  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: file,
    }).outputText;
    const localRequire = (specifier) => {
      if (specifier.startsWith('.')) return load(resolveRelative(path.dirname(file), specifier));
      if (Object.prototype.hasOwnProperty.call(bare, specifier)) return bare[specifier];
      throw new Error(
        `Unexpected require in ${path.relative(PACKAGE_DIR, file)}: ${specifier}`,
      );
    };
    vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename: file })(
      mod.exports,
      mod,
      localRequire,
    );
    return mod.exports;
  }

  const main = load(resolveRelative(PACKAGE_DIR, packageJson.main));
  const legacy = load(resolveRelative(PACKAGE_DIR, 'legacy'));

  return {
    main,
    legacy,
    specifiers: { 'expo-file-system': main, 'expo-file-system/legacy': legacy },
    device,
    platformOS,
    sdkVersion: packageJson.version,
  };
}

/**
 * Run `work` with console.warn captured. The SDK's deprecation shim warns
 * before it throws, and that warning is evidence, not noise.
 */
async function withCapturedWarnings(work) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: await work(), warnings };
  } finally {
    console.warn = original;
  }
}

module.exports = {
  DOCUMENT_DIRECTORIES,
  createFakeNativeFileSystem,
  loadExpoFileSystemSdk,
  withCapturedWarnings,
};
