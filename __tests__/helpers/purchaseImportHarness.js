// Receipt & Purchase Intelligence V1 — shared test harness.
//
// Loads the REAL TypeScript/JavaScript modules through the same
// transpile-and-vm approach the Closet suites use. Relative imports between
// real modules are resolved to the real files. Every external module must be
// named in `externals`, and an unnamed one throws: a test cannot silently run
// against a missing dependency.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function resolveRelative(fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const ext of ['', '.ts', '.tsx', '.js']) {
    const candidate = base + ext;
    if (fs.existsSync(path.join(ROOT, candidate)) && fs.statSync(path.join(ROOT, candidate)).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Load `rel` and every relative import it reaches under `realPrefixes`.
 * Anything else must be supplied in `externals`, keyed by the exact import
 * specifier as written, or by the resolved repo-relative path.
 */
function loadModule(rel, { externals = {}, realPrefixes = ['services/purchaseImport/'] } = {}) {
  const cache = new Map();
  const load = (fileRel) => {
    if (cache.has(fileRel)) return cache.get(fileRel).exports;
    const mod = { exports: {} };
    cache.set(fileRel, mod);
    const requireShim = (spec) => {
      if (Object.prototype.hasOwnProperty.call(externals, spec)) return externals[spec];
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(fileRel, spec);
        if (resolved && Object.prototype.hasOwnProperty.call(externals, resolved)) return externals[resolved];
        if (resolved && realPrefixes.some((p) => resolved.startsWith(p))) return load(resolved);
        throw new Error(`Unexpected import in ${fileRel}: ${spec} (${resolved})`);
      }
      throw new Error(`Unexpected import in ${fileRel}: ${spec}`);
    };
    // Same realm as the test, so deepStrictEqual compares like with like.
    vm.runInThisContext(`(function (exports, module, require) {\n${transpile(fileRel)}\n})`, {
      filename: fileRel,
    })(mod.exports, mod, requireShim);
    return mod.exports;
  };
  return load(rel);
}

/** In-memory expo-file-system/legacy. */
function memfs() {
  const files = new Map();
  const deleted = [];
  const api = {
    documentDirectory: '/doc/',
    cacheDirectory: '/cache/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (!files.has(p)) return { exists: false };
      return { exists: true, size: Buffer.from(files.get(p), 'utf8').length, modificationTime: 0 };
    },
    async readAsStringAsync(p) {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    async writeAsStringAsync(p, c) {
      files.set(p, c);
    },
    async copyAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
    },
    async moveAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
    },
    async deleteAsync(p) {
      deleted.push(p);
      for (const key of [...files.keys()]) {
        if (key === p || (p.endsWith('/') && key.startsWith(p))) files.delete(key);
      }
    },
    async readDirectoryAsync(dir) {
      const names = [];
      for (const key of files.keys()) {
        if (!key.startsWith(dir)) continue;
        const rest = key.slice(dir.length);
        if (!rest || rest.includes('/')) continue;
        names.push(rest);
      }
      return names;
    },
    async getFreeDiskStorageAsync() {
      return 10 * 1024 * 1024 * 1024;
    },
  };
  return { files, deleted, api };
}

function runCommonJs(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, { filename: rel })(
    mod.exports,
    mod,
    requireShim,
  );
  return mod.exports;
}

/** The REAL Closet store over an in-memory filesystem (as closetCorrectionAuthority.test.js). */
function loadClosetStore({ platform = 'ios' } = {}) {
  const m = memfs();
  const actorContext = runCommonJs('services/actorContext.js', () => ({}));
  let seq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => {
      seq += 1;
      const out = `/cache/derived_${seq}.jpg`;
      m.files.set(out, Buffer.from(`derived:${uri}`).toString('base64'));
      return { uri: out };
    },
  };
  const library = runCommonJs('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './identificationSnapshot') return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({}), softDeleteCloudSavedScan: async () => ({}) };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return { isPurchaseOptionsSnapshot: Array.isArray, normalizePurchaseOptions: (v) => (Array.isArray(v) ? v : []) };
    }
    return {};
  });
  const closetLibrary = runCommonJs('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: platform } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });
  return { m, closetLibrary, actorContext };
}

const CLOSET_PATH = '/doc/kscan_closet/kscan_closet.json';

function readCloset(m) {
  return JSON.parse(m.files.get(CLOSET_PATH) ?? '[]');
}

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

module.exports = { ROOT, loadModule, memfs, loadClosetStore, readCloset, readRepo, CLOSET_PATH };
