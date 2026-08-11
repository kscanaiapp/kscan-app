// Contextual fashion follow-ups (image styling loop, Commit 2).
//
// The properties that matter:
//   * the action set is deterministic and category-correct
//   * never more than three, and never a control that cannot complete
//   * a tap submits a predefined prompt through the EXISTING send pipeline —
//     no second identification, no second upload, no second candidate, no
//     second session, no second provider
//   * the item's already-derived fashion context is carried forward, so the
//     answer is about the same garment
//   * Closet persistence only ever ADDS an action; it never gates one
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier === 'expo-crypto') {
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256) };
    }
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  const sandbox = { exports: mod.exports, module: mod, require: localRequire, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const loop = loadModule('services/style-chat/eliseImageStylingLoop.ts');

const OWNED_ID = '11111111-2222-4333-8444-555555555555';

function ctx(overrides = {}) {
  return {
    draftId: 'att_1',
    title: 'Black satin midi dress',
    thumbnailUri: 'file:///thumb.jpg',
    categoryBucket: 'dress',
    attachmentState: 'ready',
    closetState: 'not_saved',
    owned: false,
    styled: false,
    ...overrides,
  };
}

// `.map` on an array built inside the transpile sandbox returns a SANDBOX array,
// which deepEqual rejects against a test-realm literal on realm identity rather
// than on value. Comparing joined strings compares what we actually mean.
const labels = (actions) => Array.from(actions, (action) => action.label);
const types = (actions) => Array.from(actions, (action) => action.type).join('|');

// ── Bounds ───────────────────────────────────────────────────────────────────

test('no state produces more than three actions, or an unlabelled one', () => {
  const buckets = ['dress', 'outerwear', 'footwear', 'top', 'bottom', 'bag', 'accessory', 'other'];
  const states = ['ready', 'sending', 'sent', 'send_failed'];
  const closetStates = ['not_saved', 'saving', 'saved', 'save_failed'];

  for (const categoryBucket of buckets) {
    for (const attachmentState of states) {
      for (const closetState of closetStates) {
        for (const styled of [false, true]) {
          const owned = closetState === 'saved';
          const actions = loop.resolveFollowUpActions(
            ctx({ categoryBucket, attachmentState, closetState, owned, styled }),
          );
          assert.ok(actions.length >= 2 && actions.length <= 3, `${categoryBucket}/${attachmentState}/${closetState}`);
          assert.equal(new Set(actions.map((a) => a.id)).size, actions.length, 'ids must be unique');
          for (const action of actions) {
            assert.ok(action.label && action.label.trim(), 'every action needs a label');
            assert.ok(
              action.accessibilityLabel && action.accessibilityLabel.trim(),
              'every action needs an accessible name',
            );
            if (action.type === 'prompt') assert.ok(action.prompt, 'a prompt action must carry its prompt');
          }
        }
      }
    }
  }
});

test('no context means no follow-ups', () => {
  assert.equal(loop.resolveFollowUpActions(null).length, 0);
  assert.equal(loop.resolveFollowUpLeadIn(null), null);
});

// ── Category correctness ─────────────────────────────────────────────────────

test('each category asks the question that category actually raises', () => {
  const forBucket = (categoryBucket) =>
    labels(loop.resolveFollowUpActions(ctx({ categoryBucket, attachmentState: 'sent' })));

  assert.ok(forBucket('dress').includes('Make this more casual'));
  assert.ok(forBucket('outerwear').includes('What should I wear under this?'));
  assert.ok(forBucket('footwear').includes('What colors go with these?'));
  assert.ok(forBucket('top').includes('Dress this up'));
  assert.ok(forBucket('bottom').includes('What shoes work?'));

  // A handbag gets no slot-specific question, because there is no honest one.
  const bag = forBucket('bag');
  assert.ok(!bag.includes('What pants work?'));
  assert.ok(bag.includes('What colors go with this?'));
});

test('the action set is a pure function of state', () => {
  const context = ctx({ attachmentState: 'sent' });
  assert.deepEqual(
    labels(loop.resolveFollowUpActions(context)),
    labels(loop.resolveFollowUpActions(context)),
  );
  assert.equal(
    types(loop.resolveFollowUpActions(context)),
    types(loop.resolveFollowUpActions(context)),
  );
});

// ── State rules ──────────────────────────────────────────────────────────────

test('an unsaved item offers questions plus an optional save', () => {
  for (const attachmentState of ['ready', 'sent']) {
    const actions = loop.resolveFollowUpActions(ctx({ attachmentState }));
    assert.equal(types(actions), 'prompt|prompt|save_to_closet');
    assert.equal(actions[0].prompt, 'What would you wear with this?');
    assert.equal(actions[2].label, 'Save to Closet');
  }
});

test('a failed save offers a retry and leaves the questions in place', () => {
  const actions = loop.resolveFollowUpActions(
    ctx({ attachmentState: 'sent', closetState: 'save_failed' }),
  );
  assert.equal(types(actions), 'prompt|prompt|save_to_closet');
  assert.equal(actions[2].label, 'Try again');
  assert.equal(actions[2].busy, undefined);
});

test('a save in flight stays mounted and announces itself busy', () => {
  const actions = loop.resolveFollowUpActions(
    ctx({ attachmentState: 'sent', closetState: 'saving' }),
  );
  const save = actions.find((action) => action.type === 'save_to_closet');
  assert.equal(save.label, 'Saving…');
  assert.equal(save.busy, true);
});

test('Style This Item appears only after confirmed ownership', () => {
  for (const closetState of ['not_saved', 'saving', 'save_failed']) {
    const actions = loop.resolveFollowUpActions(ctx({ closetState, owned: false }));
    assert.ok(
      !types(actions).includes('style_this_item'),
      `${closetState} must not offer Style This Item`,
    );
  }
  const owned = loop.resolveFollowUpActions(ctx({ closetState: 'saved', owned: true }));
  assert.ok(types(owned).startsWith('style_this_item'));
  assert.ok(!types(owned).includes('save_to_closet'), 'an owned item is not offered a save');
});

test('an item already handed off offers the Dressing Room, not a phantom Look', () => {
  const actions = loop.resolveFollowUpActions(
    ctx({ closetState: 'saved', owned: true, styled: true }),
  );
  assert.equal(types(actions), 'open_dressing_room|change_something|prompt');
  // "Open Look" is deliberately absent: no Look association exists in this
  // build, and offering one would be a control that cannot complete.
  assert.ok(!labels(actions).some((label) => /open look/i.test(label)));
});

test('the lead-in is state-driven copy, never model output', () => {
  assert.equal(loop.resolveFollowUpLeadIn(ctx({ attachmentState: 'ready' })), 'Ask Elise about this');
  assert.equal(loop.resolveFollowUpLeadIn(ctx({ attachmentState: 'sent' })), 'Like this piece?');
  assert.equal(loop.resolveFollowUpLeadIn(ctx({ owned: true, closetState: 'saved' })), 'Keep going');
  assert.equal(
    loop.resolveFollowUpLeadIn(ctx({ owned: true, closetState: 'saved', styled: true })),
    'Back to your Dressing Room',
  );
});

// ── Pipeline reuse ───────────────────────────────────────────────────────────

test('follow-ups submit through the one existing send pipeline', () => {
  const screen = read('app/style-chat/[sessionId].tsx');

  // Exactly one place builds a send, and the composer uses it too.
  assert.match(screen, /const submitMessage = useCallback\(/);
  assert.match(
    screen,
    /onSend=\{\(text\) => \{ void submitMessage\(text, \{ clearComposer: true \}\); \}\}/,
  );
  assert.match(screen, /void submitMessage\(prompt, \{ clearComposer: false \}\)/);
  // This line has three send branches, not two: the attachment snapshot, the
  // live header-gallery visual context, and text. All three are inside
  // `submitMessage`, and nothing outside it calls sendMessage.
  assert.equal(
    (screen.match(/await sendMessage\(/g) ?? []).length,
    3,
    'the attachment, visual-context and text branches are the only sends',
  );
  const pipeline =
    screen.match(/const submitMessage = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.equal(
    (pipeline.match(/await sendMessage\(/g) ?? []).length,
    3,
    'every send lives inside the one pipeline',
  );

  // A chip never restarts the intake, and never mints a candidate or a session.
  const handler =
    screen.match(/const handleFollowUpPrompt = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.ok(handler, 'the follow-up handler must exist');
  for (const forbidden of [
    'setPhotoIntakeVisible',
    'identifyScanImage',
    'createClosetCandidate',
    'addUnsavedDirectImage',
    'createStyleChatSession',
    'sanitizeImageBeforeUpload',
  ]) {
    assert.ok(!handler.includes(forbidden), `a follow-up must not call ${forbidden}`);
  }
});

test('a follow-up carries the identity already derived for the photo', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /resolveActiveItemFashionContext\(chatAttachments\.attachments, activeItem\.draftId\)/);
  // Through the SAME additive field every other Elise source uses.
  assert.match(screen, /fashionContext: carriedContext/);

  const module = read('services/style-chat/eliseImageStylingLoop.ts');
  // The carried object is the validated styling-safe projection, revalidated on
  // every read rather than trusted from the draft's `unknown` field.
  assert.match(module, /validateEliseFashionContextV2\(draft\.fashionContext\)/);

  // A malformed or absent context carries nothing rather than something invented.
  assert.equal(loop.resolveActiveItemFashionContext([], 'att_1'), null);
  assert.equal(
    loop.resolveActiveItemFashionContext(
      [{ draftId: 'att_1', fashionContext: { contractVersion: 'nope' } }],
      'att_1',
    ),
    null,
  );
});

test('a follow-up never wipes text the user was typing', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /if \(clearComposer\) setComposerText\(''\)/);
  const handler =
    screen.match(/const handleFollowUpPrompt = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.match(handler, /clearComposer: false/);
});

test('an action with no handler is not rendered', () => {
  const bar = read('components/style-chat/StyleChatFollowUpBar.tsx');
  assert.match(bar, /\.filter\(\(entry\)[\s\S]*entry\.onPress !== null/);
  // The bar renders; it does not decide.
  assert.match(bar, /resolveFollowUpActions\(context\)/);
  for (const forbidden of ['generateReply', 'identifyScanImage', 'supabase', 'fetch(']) {
    assert.ok(!bar.includes(forbidden), `the follow-up bar must not call ${forbidden}`);
  }
});

test('attach-first survives: an unsaved attachment still gets follow-ups', () => {
  const unsaved = loop.resolveFollowUpActions(ctx({ attachmentState: 'ready', closetState: 'not_saved' }));
  assert.ok(unsaved.filter((action) => action.type === 'prompt').length >= 2);
  const failedSave = loop.resolveFollowUpActions(
    ctx({ attachmentState: 'sent', closetState: 'save_failed' }),
  );
  assert.ok(failedSave.filter((action) => action.type === 'prompt').length >= 2);
});
