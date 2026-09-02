// The real Elise copy constants, loaded without pulling in the rest of the
// module graph, so UX copy contracts are asserted against shipped strings.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '..', '..', 'constants', 'elise.ts');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module_ = { exports: {} };
vm.runInNewContext(
  output,
  {
    exports: module_.exports,
    module: module_,
    Object,
    require: (id) => {
      throw new Error(`Unexpected require in constants/elise.ts: ${id}`);
    },
  },
  { filename },
);

module.exports = module_.exports;
