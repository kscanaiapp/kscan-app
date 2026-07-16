const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const sourcePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const customRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(sourcePath), specifier.replace(/\.ts$/, ''));
      const candidate = `${resolved}.ts`;
      if (fs.existsSync(candidate)) {
        return loadTsModule(path.relative(ROOT, candidate).replace(/\\/g, '/'));
      }
    }
    throw new Error(`Unexpected import: ${specifier} from ${relativePath}`);
  };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(customRequire, mod, mod.exports);
  return mod.exports;
}

test('Elise one/three/six-image collections preserve order through envelope', () => {
  const { parseActiveContext, buildActiveContextBlock } = loadTsModule(
    'supabase/functions/stylechat-generate/activeContext.ts',
  );
  const { assembleStyleChatPrompt } = loadTsModule('services/aiSecurity/styleChatPromptAssembly.ts');

  for (const count of [1, 3, 6]) {
    const evidence = Array.from({ length: count }, (_, index) => ({
      id: `item-${index + 1}`,
      order: count - index,
      source: 'scan',
      title: `Distinct item ${index + 1}`,
    }));
    const parsed = parseActiveContext({
      source: 'camera',
      visualCollection: { evidence, focusEvidenceId: 'item-1' },
    });
    assert.equal(parsed.visualCollection.evidence.length, count);
    assert.equal(
      parsed.visualCollection.evidence.map((entry) => entry.order).join(','),
      Array.from({ length: count }, (_, index) => index + 1).join(','),
    );
    const block = buildActiveContextBlock(parsed);
    const assembled = assembleStyleChatPrompt({
      systemRules: 'Elise rules',
      userMessage: 'How do these work together?',
      visualContextBlock: block,
    });
    assert.match(assembled.userEnvelopeText, /<visual_context trust="untrusted_derived">/);
    assert.doesNotMatch(assembled.systemText, /Distinct item/);
    for (let index = 1; index <= count; index += 1) {
      assert.match(assembled.userEnvelopeText, new RegExp(`Distinct item ${index}`));
    }
  }
});

test('Elise text-only and legacy active context remain compatible', () => {
  const { parseActiveContext, buildActiveContextBlock } = loadTsModule(
    'supabase/functions/stylechat-generate/activeContext.ts',
  );
  const { assembleStyleChatPrompt } = loadTsModule('services/aiSecurity/styleChatPromptAssembly.ts');

  const textOnly = assembleStyleChatPrompt({
    systemRules: 'Elise rules',
    userMessage: 'What pants go with a white polo?',
  });
  assert.match(textOnly.userEnvelopeText, /white polo/);
  assert.match(textOnly.systemText, /<kscan_system_rules>/);

  const legacy = parseActiveContext({
    source: 'upload',
    visualContext: { source: 'upload', title: 'Purple lace top', colors: ['plum'] },
  });
  const legacyAssembled = assembleStyleChatPrompt({
    systemRules: 'Elise rules',
    userMessage: 'Style this',
    visualContextBlock: buildActiveContextBlock(legacy),
  });
  assert.match(legacyAssembled.userEnvelopeText, /Purple lace top/);
  assert.equal(legacy.visualCollection.evidence.length, 1);
});

test('StyleChat actions reject rpc/route/sql shaped payloads', () => {
  const { validateStyleChatActions } = loadTsModule(
    'supabase/functions/stylechat-generate/actions.ts',
  );
  const { authorizeModelAction } = loadTsModule(
    'services/aiSecurity/actionAuthorization.ts',
  );
  const owned = {
    itemKeys: new Set(),
    lookIds: new Set(),
  };
  const validated = validateStyleChatActions(
    [{ type: 'delete_user_account', rpc: 'drop', route: '/admin', sql: 'DROP TABLE users' }],
    [],
  );
  assert.equal(validated.length, 0);
  const denied = authorizeModelAction({
    actor: { actorId: 'u1', authenticated: true },
    actionType: 'open_stylist',
    allowedActionTypes: ['open_stylist'],
    payload: { rpc: 'delete_user_account' },
    owned,
  });
  assert.equal(denied.allowed, false);
});

test('TypeChat injection corpus remains data and unsafe actions fail closed', () => {
  const {
    assembleTypeChatPrompt,
    validateTypeChatModelOutput,
    INJECTION_FIXTURES,
    rejectExecutableInstruction,
  } = loadTsModule('services/aiSecurity/index.ts');

  for (const fixture of INJECTION_FIXTURES) {
    const assembled = assembleTypeChatPrompt({
      systemRules: 'Fashion JSON only.',
      userQuery: fixture.text.slice(0, 300),
    });
    if (!assembled.queryAccepted) continue;
    assert.match(assembled.userEnvelopeText, /<user_input trust="untrusted_user">/);
    assert.doesNotMatch(assembled.systemText, /<user_input/);
  }

  assert.equal(
    rejectExecutableInstruction({ status: 'completed', rpc: 'delete_user_account' }),
    true,
  );
  assert.equal(
    validateTypeChatModelOutput({
      status: 'completed',
      route: '/admin',
      userMessage: 'hi',
    }).ok,
    false,
  );
  assert.equal(
    validateTypeChatModelOutput({
      status: 'non_fashion',
      userMessage: 'Not a fashion query.',
    }).ok,
    true,
  );
  assert.equal(
    validateTypeChatModelOutput({
      status: 'completed',
      userMessage: 'A navy wool blazer.',
      attributes: { category: 'blazer' },
      identification: { item_type: 'blazer', non_fashion: false },
      recommendedProducts: [],
    }).ok,
    true,
  );
});
