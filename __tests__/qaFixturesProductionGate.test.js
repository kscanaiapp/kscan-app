const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadQaFixtures(isDev) {
  const filename = path.join(ROOT, 'constants/qaFixtures.js');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const requires = [];
  vm.runInNewContext(
    output,
    {
      __DEV__: isDev,
      module,
      exports: module.exports,
      require: (id) => {
        requires.push(id);
        return { uri: id };
      },
    },
    { filename },
  );
  return { fixtures: module.exports.QA_FIXTURES, requires };
}

test('production QA_FIXTURES export is empty and loads no fixture assets', () => {
  const { fixtures, requires } = loadQaFixtures(false);
  assert.ok(Array.isArray(fixtures));
  assert.equal(fixtures.length, 0);
  assert.equal(requires.length, 0);
});

test('dev QA_FIXTURES resolve fixture assets', () => {
  const { fixtures, requires } = loadQaFixtures(true);
  assert.ok(fixtures.length >= 8);
  assert.ok(requires.every((id) => id.includes('qa_fixtures')));
});

test('app.js keeps QA tools behind QA_TOOLS_ENABLED', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /if \(!QA_TOOLS_ENABLED\) return null;/);
  assert.match(app, /QA_TOOLS_ENABLED/);
});

test('build gate ties QA tools to __DEV__ only', () => {
  const build = fs.readFileSync(path.join(ROOT, 'constants/build.js'), 'utf8');
  assert.match(build, /QA_TOOLS_ENABLED/);
  assert.match(build, /__DEV__ === true/);
});
