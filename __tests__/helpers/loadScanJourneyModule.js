// Loads the REAL `services/scanJourney.ts` for the useKScan vm harnesses.
//
// Those harnesses strip the hook's imports and supply each dependency by name
// on the sandbox global. That works well for things worth stubbing — the
// network, the clock, React — but `readScanJourney` and `selectionDispatchFor`
// are pure functions that interpret the backend contract, and a hand-written
// stub of them would silently diverge from the module the app actually ships.
//
// So the harness gets the real implementation, transpiled in place. If the
// contract reading changes, the hook tests see the change.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');

function loadTsModule(relative) {
  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    // `scanJourney.ts` imports only a type from `scanJourneyTypes`, which the
    // transpiler elides, so no local resolution is needed here.
    require: (id) => {
      throw new Error(`scanJourney must stay dependency-free; saw '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const scanJourney = loadTsModule('services/scanJourney.ts');

/** The named globals the useKScan harnesses must expose. */
module.exports = {
  readScanJourney: scanJourney.readScanJourney,
  selectionDispatchFor: scanJourney.selectionDispatchFor,
};
