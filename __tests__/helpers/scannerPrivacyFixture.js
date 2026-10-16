'use strict';

// Protocol fixtures exercise post-native transport behavior. This is deliberately
// not native masking certification; the independent privacy component suite owns it.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function loadScannerDispatchGuard(root) {
  const file = path.join(root, 'services/privacy/scannerDispatchGuard.ts');
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { module: mod, exports: mod.exports });
  return mod.exports;
}
function fixtureInput(guard, input) {
  const proof = { processingCompleted: true, outputVerified: true, metadataStripped: true,
    faceDetectionPerformed: true, plateDetectionPerformed: true };
  guard.registerScannerImageForDispatch(input.evidence.imageBase64, proof);
  return { ...input, privacyProof: proof };
}
module.exports = { loadScannerDispatchGuard, fixtureInput };
