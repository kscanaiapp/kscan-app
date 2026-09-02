/**
 * Loader for the Avatar Engine V10 sources under `node --test`.
 *
 * The repository's convention is to transpile a single TypeScript file and
 * evaluate it with an injected `require` that throws, which proves the file has
 * no runtime dependencies. The engine is several files, so this harness extends
 * the same idea into a miniature linker:
 *
 *   - relative imports between engine files are resolved and transpiled,
 *   - a BARE specifier (react, react-native, expo-audio, @supabase/...) throws,
 *     which is what makes the purity test meaningful rather than decorative,
 *   - image assets requested by the host registry resolve to a fake positive
 *     Metro module id, because Node cannot require a PNG.
 *
 * Anything the engine core imports that is not another engine file is therefore
 * a test failure by construction.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');

/** Assets the host registry references. Metro returns an opaque positive id. */
const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
let nextFakeAssetId = 1000;

function resolveSourceFile(specifierPath) {
  const candidates = [
    specifierPath,
    `${specifierPath}.ts`,
    `${specifierPath}.tsx`,
    path.join(specifierPath, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * @param {string} entryRelativePath repo-relative path, e.g.
 *   'services/avatars/engine/index.ts'
 * @param {object} [options]
 * @param {(specifier: string, fromFile: string) => unknown} [options.onBareSpecifier]
 *   Called for any non-relative import. Defaults to throwing, which is the
 *   behaviour the purity test depends on.
 */
function loadTsModule(entryRelativePath, options = {}) {
  const cache = new Map();
  const onBareSpecifier =
    options.onBareSpecifier ??
    ((specifier, fromFile) => {
      throw new Error(
        `Forbidden runtime dependency: ${path.relative(ROOT, fromFile)} imports "${specifier}"`,
      );
    });

  function load(absoluteFile) {
    const cached = cache.get(absoluteFile);
    if (cached) return cached.exports;

    const source = fs.readFileSync(absoluteFile, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: absoluteFile,
    });

    const module = { exports: {} };
    cache.set(absoluteFile, module);

    const localRequire = (specifier) => {
      if (!specifier.startsWith('.')) return onBareSpecifier(specifier, absoluteFile);

      const resolved = path.resolve(path.dirname(absoluteFile), specifier);
      if (ASSET_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
        nextFakeAssetId += 1;
        return nextFakeAssetId;
      }
      const file = resolveSourceFile(resolved);
      if (!file) throw new Error(`Cannot resolve ${specifier} from ${path.relative(ROOT, absoluteFile)}`);
      return load(file);
    };

    const evaluate = new Function('require', 'module', 'exports', '__filename', '__dirname', outputText);
    evaluate(localRequire, module, module.exports, absoluteFile, path.dirname(absoluteFile));
    return module.exports;
  }

  const entry = resolveSourceFile(path.join(ROOT, entryRelativePath));
  if (!entry) throw new Error(`Entry not found: ${entryRelativePath}`);
  return load(entry);
}

/**
 * Returns the file's executable code with comments and type-only syntax
 * removed, preserving ESM import statements.
 *
 * Coupling scanners must read this rather than the raw file. A doc comment
 * explaining that the engine does not touch Supabase contains the word
 * "Supabase", and a scanner run over raw text would fail on the very comment
 * documenting the guarantee it is checking.
 */
function executableSource(relativePath) {
  const absolute = resolveSourceFile(path.join(ROOT, relativePath));
  if (!absolute) throw new Error(`Source not found: ${relativePath}`);
  const source = fs.readFileSync(absolute, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      removeComments: true,
    },
    fileName: absolute,
  }).outputText;
}

/** The engine core, loaded with bare imports forbidden. */
function loadEngine() {
  return loadTsModule('services/avatars/engine/index.ts');
}

/**
 * The host adapter. Its only bare-specifier need would be React, and it uses
 * `import type` for every host reference, so bare imports stay forbidden here
 * too — an accidental value import from a store or component fails the test.
 */
function loadAdapter() {
  return loadTsModule('services/avatars/avatarEngineAdapter.ts');
}

function loadPackages() {
  return loadTsModule('services/avatars/avatarEnginePackages.ts');
}

// -- Alignment builders -------------------------------------------------------

/** Character alignment in the exact shape the K Scan speech backend returns. */
function characterAlignment(text, startSeconds = 0, perCharacterSeconds = 0.06) {
  const characters = [...text];
  const characterStartTimesSeconds = [];
  const characterEndTimesSeconds = [];
  let cursor = startSeconds;
  for (let index = 0; index < characters.length; index += 1) {
    characterStartTimesSeconds.push(round(cursor));
    cursor += perCharacterSeconds;
    characterEndTimesSeconds.push(round(cursor));
  }
  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** A capability set describing an avatar with a complete mouth and nothing else. */
function mouthOnlyCapabilities(overrides = {}) {
  return {
    base: true,
    mouthClosed: true,
    mouthHalfOpen: true,
    mouthOpen: true,
    mouthRound: false,
    mouthWide: false,
    eyes: false,
    brows: false,
    gaze: false,
    compositeMotion: true,
    tapAcknowledgement: true,
    ...overrides,
  };
}

/** A minimal, valid host snapshot; override only what a test is exercising. */
function snapshot(overrides = {}) {
  return {
    avatarId: 'stylist_portrait_05',
    speechGeneration: 1,
    phase: 'playing',
    playing: true,
    playbackPositionSeconds: 0,
    playbackAvailable: true,
    hostNowMs: 0,
    foreground: true,
    reduceMotion: false,
    motionEpoch: 0,
    motionEnabled: true,
    lipSyncEnabled: true,
    ...overrides,
  };
}

module.exports = {
  ROOT,
  loadTsModule,
  executableSource,
  loadEngine,
  loadAdapter,
  loadPackages,
  characterAlignment,
  mouthOnlyCapabilities,
  snapshot,
};
