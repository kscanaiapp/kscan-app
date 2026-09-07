'use strict';

/**
 * Loads a real production .ts source file under `node --test` by
 * transpiling it in-memory (no ts-node/babel register configured for this
 * repo's test runner). Same technique __tests__/commerceCurrencyTruth.test.js
 * already uses (`createClientLoader`/`loadEdgeModule`) - reimplemented here,
 * not imported from that test file, because test files in this repo don't
 * export shared helpers and editing an existing test file to export one
 * would reach outside this lane's diff fence (spec section 52).
 *
 * This corpus ONLY ever loads pure-logic modules this way (currency/URL/
 * watch-identity helpers with no React Native runtime dependency) - never a
 * component, never anything requiring a Supabase/network mock. If a target
 * module needs a runtime dependency this loader can't satisfy, that is a
 * signal to route around it, not to grow this loader into a full test
 * harness.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '../../..');

function createModuleLoader(rootDir = REPO_ROOT, mocks = {}) {
  const cache = new Map();

  function resolveFile(candidate) {
    const candidates = path.extname(candidate) ? [candidate] : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }

  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`loadProductionModule: unable to resolve ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;

    const mod = { exports: {} };
    cache.set(resolved, mod);

    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: resolved,
    }).outputText;

    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      return require(id);
    };

    Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      output,
    )(mod.exports, localRequire, mod, resolved, path.dirname(resolved));

    return mod.exports;
  }

  return (relativePath) => loadFile(path.resolve(rootDir, relativePath));
}

module.exports = { createModuleLoader };
