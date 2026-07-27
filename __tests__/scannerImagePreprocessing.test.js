const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadImageUtils(manipulateAsync) {
  let source = fs.readFileSync(path.join(ROOT, 'services/imageUtils.js'), 'utf8');
  source = source
    .replace(/^import .*$/gm, '')
    .replace('export async function compressForUpload', 'async function compressForUpload');
  source += '\nmodule.exports = { compressForUpload };';
  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: false,
    console: { log: () => {}, error: () => {} },
    ImageManipulator: {
      manipulateAsync,
      SaveFormat: { JPEG: 'jpeg' },
    },
  };
  vm.runInNewContext(source, context, {
    filename: path.join(ROOT, 'services/imageUtils.js'),
  });
  return context.module.exports;
}

test('generated high-resolution gallery input uses the bounded Scanner preprocessing contract', async () => {
  const input = {
    uri: 'file://generated-6000x4000-gallery.jpg',
    width: 6000,
    height: 4000,
  };
  const outputBase64 = 'A'.repeat(1024 * 1024);
  let invocation;
  const imageUtils = loadImageUtils(async (uri, actions, options) => {
    invocation = { uri, actions, options };
    return { uri: 'file://prepared-896x597.jpg', width: 896, height: 597, base64: outputBase64 };
  });

  const prepared = await imageUtils.compressForUpload(input.uri);

  assert.equal(invocation.uri, input.uri);
  assert.deepEqual(JSON.parse(JSON.stringify(invocation.actions)), [{ resize: { width: 896 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(invocation.options)), {
    compress: 0.65,
    format: 'jpeg',
    base64: true,
  });
  assert.match(prepared, /^data:image\/jpeg;base64,/);
  assert.ok(outputBase64.length < 2 * 1024 * 1024, 'generated output remains inside request limit');
});
