const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
const attachmentBar = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'StyleChatAttachmentBar.tsx'),
  'utf8',
);

function transpileModule(file, mocks) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    exports: mod.exports,
    module: mod,
    process: { env: {} },
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

test('StyleChat restores the approved add control when attachments are enabled', () => {
  assert.match(screen, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED/);
  assert.match(screen, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED \|\| isStylistFeatureEnabled\('aiStylist'\)/);
  assert.match(screen, /attachmentsEnabled \? \(/);
  assert.match(attachmentBar, /testID="stylechat-attach-button"/);
  assert.match(attachmentBar, /onPress=\{\(\) => setMenuOpen\(true\)\}/);
});

// Regression: the screen imported ELISE_VISUAL_ATTACHMENTS_V1_ENABLED as a
// named export of constants/featureFlags for a long time before the export
// actually existed there. TypeScript caught it (TS2305); the source-text
// regex checks above did not, because they never transpile/execute the
// module — they would stay green even with the import resolving to
// `undefined` at runtime and silently collapsing the attachment gate behind
// the broader aiStylist freeze. This loads the real compiled module so a
// future rename/deletion of the export fails a test, not just `tsc`.
test('ELISE_VISUAL_ATTACHMENTS_V1_ENABLED is an actual executable export, not just referenced text', () => {
  const flags = transpileModule('constants/featureFlags.ts', {});
  assert.equal('ELISE_VISUAL_ATTACHMENTS_V1_ENABLED' in flags, true);
  assert.equal(typeof flags.ELISE_VISUAL_ATTACHMENTS_V1_ENABLED, 'boolean');
});

test('StyleChat add sheet resolves the active stylist and keeps its existing options', () => {
  assert.match(screen, /stylistDisplayName=\{stylistDisplayName\}/);
  assert.match(attachmentBar, /Add for \$\{resolvedStylistName\}/);
  assert.match(attachmentBar, /title="Add From Closet"/);
  assert.match(attachmentBar, /title="Add a Look"/);
  assert.match(attachmentBar, /title="Upload a Photo"/);
  assert.match(attachmentBar, /onUploadPhoto\(\)/);
  assert.match(attachmentBar, /Add From Closet for \$\{stylistDisplayName\}/);
  assert.match(attachmentBar, /Add a Look for \$\{stylistDisplayName\}/);
});

// Regression: LookPickerModal declares stylistDisplayName as a required prop
// and renders it in its title, but its call site inside
// StyleChatAttachmentBar never passed it — every stylist, not just Henry,
// would show "Add a Look for undefined". TypeScript caught it (TS2741); the
// broader source-text assertions above did not, because they check that the
// substring exists anywhere in the file, not that this specific call site
// passes it. This isolates the LookPickerModal invocation itself.
test('LookPickerModal call site passes the resolved stylist name, not just ClosetPickerModal', () => {
  const lookCallSite = attachmentBar.slice(
    attachmentBar.indexOf("picker === 'look'"),
    attachmentBar.indexOf('onSelect={(look) => {'),
  );
  assert.match(
    lookCallSite,
    /<LookPickerModal[\s\S]*stylistDisplayName=\{resolvedStylistName\}/,
    'LookPickerModal must receive the resolved stylist name the same way ClosetPickerModal does',
  );
});
