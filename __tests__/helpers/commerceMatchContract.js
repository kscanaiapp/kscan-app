// Executes the real portable production contract for fixed-map VM harnesses.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();
function loadPortable(relativePath) {
  const filename = path.resolve(root, relativePath);
  if (cache.has(filename)) return cache.get(filename);
  const module = { exports: {} };
  cache.set(filename, module.exports);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const localRequire = id => {
    if (id === '../_shared/net/safeRemoteMedia.ts') return loadPortable('supabase/functions/_shared/net/safeRemoteMedia.ts');
    throw new Error(`Unexpected portable contract import: ${id}`);
  };
  Function('module', 'exports', 'require', 'URL', 'URLSearchParams', source)(module, module.exports, localRequire, URL, URLSearchParams);
  return module.exports;
}
function resolveCommerceContractImport(id) {
  if (id === '../supabase/functions/scan-identify/matchTier' || id === '../../supabase/functions/scan-identify/matchTier') return loadPortable('supabase/functions/scan-identify/matchTier.ts');
  if (id === './scannerVisualEvidence') return loadPortable('services/scannerVisualEvidence.ts');
  return undefined;
}
module.exports = { loadPortable, resolveCommerceContractImport };
