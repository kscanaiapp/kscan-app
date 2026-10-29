const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, require: (id) => { if (id in imports) return imports[id]; throw new Error(id); }, Set, Map, console });
  return module.exports;
}
const legal = load('constants/legal.ts');
test('Gemini disclosure explicitly covers provider, image and Elise text transfer', () => {
  const source = fs.readFileSync('app/onboarding/index.tsx', 'utf8');
  assert.match(source, /Photos and text[^<]*Elise chats[^<]*Google Gemini/);
  assert.match(source, /I consent to Gemini processing/);
});
test('existing image-only v1 acceptance cannot bypass the expanded Gemini disclosure', async () => {
  const old = 'terms:1.0|privacy:1.0|minimum_age:1.0|ai_processing:v1';
  let remoteChecks = 0;
  const service = load('services/onboardingCompletion.ts', {
    '@react-native-async-storage/async-storage': { getItem: async () => old },
    './legalAcceptance': { hasCurrentLegalAcceptances: async () => { remoteChecks++; return false; } },
    '../constants/legal': legal,
  });
  assert.equal(await service.resolveOnboardingCompletion('synthetic-user'), false);
  assert.equal(remoteChecks, 1);
});
