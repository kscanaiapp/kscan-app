const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const jsonRegistry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8'),
);

function loadEdgeRegistry() {
  const filename = path.join(
    ROOT,
    'supabase',
    'functions',
    '_shared',
    'deletion',
    'userDataResources.ts',
  );
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module }, { filename });
  return module.exports;
}

function comparableTable(resource) {
  return {
    table: resource.table,
    column: resource.column,
    action: resource.action,
    optional: resource.optional ?? false,
    count: resource.count ?? true,
  };
}

test('Node and Edge account-deletion registries stay in exact behavioral parity', () => {
  const edge = loadEdgeRegistry();

  assert.deepEqual(
    Array.from(edge.REQUIRED_REGISTRY_TABLES),
    jsonRegistry.requiredRegistryTables,
  );
  assert.deepEqual(
    Array.from(edge.STORAGE_RESOURCE_TEMPLATES, (resource) => ({
      bucket: resource.bucket,
      prefixTemplates: Array.from(resource.prefixTemplates),
    })),
    jsonRegistry.storage,
  );
  assert.deepEqual(
    Array.from(edge.USER_DATA_RESOURCES, comparableTable),
    jsonRegistry.tables.map(comparableTable),
  );
});
