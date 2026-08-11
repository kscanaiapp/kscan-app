// Persistent visible item context for Elise (image styling loop, Commit 1).
//
// These call the SAME pure functions the screen calls. There is no React test
// infrastructure in this repository, so a harness that reimplemented the
// selection rules would prove a behaviour production never runs —
// privateDressingRoomEliseOrchestration.test.js makes the same choice for the
// same reason.
//
// The properties that matter:
//   * an identified attachment becomes the visible active item
//   * the context is DERIVED, so a rerender or a background/foreground cycle
//     cannot change it while the drafts are unchanged
//   * clearing and replacing are draft removals, not a second store
//   * an actor change / sign-out clears it, because the store it reads is reset
//   * ownership is never implied by attachment
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
    // The identity validator reaches the evidence gateway, which reaches
    // expo-crypto. Deterministic bytes keep the graph loadable without pulling a
    // native module into a node:test process.
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A validated canonical context, built to the real contract the client sends. */
function identity(overrides = {}) {
  return {
    identityVersion: 'elise-fashion-identity-v2',
    // The ITEM state is 'ready'; the IDENTITY status is an identification
    // status, and 'completed' is its success value. They are separate enums.
    status: 'completed',
    resolutionLevel: 'subtype',
    category: 'Dresses',
    subtype: 'midi dress',
    brand: { value: null, confidence: null, provenance: 'unknown' },
    colors: { primary: 'black', secondary: [] },
    material: ['satin'],
    silhouette: [],
    pattern: [],
    attributes: {
      fit: null, length: null, sleeve: null, neckline: null, collar: null,
      closure: null, pockets: [], visible: [], distinctive: [],
    },
    confidence: {
      category: 0.9, subtype: 0.8, brand: null, modelFamily: null, exactProduct: null,
    },
    exactProduct: null,
    conflicts: [],
    unknownReason: null,
    globalConfidence: 0.85,
    ...overrides,
  };
}

function context(identityOverrides = {}) {
  return {
    contractVersion: 'elise-fashion-context-v2',
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: identity(identityOverrides) }],
  };
}

function draft(overrides = {}) {
  const { selection: selectionOverrides, summary: summaryOverrides, ...rest } = overrides;
  return {
    draftId: 'att_1',
    state: 'ready',
    selection: {
      localImageUri: 'file:///photo.jpg',
      sanitizedImageUri: 'file:///photo.jpg',
      closetCandidateId: 'cand-1',
      closetCandidateBatchId: 'batch-1',
      retryCount: 0,
      updatedAt: '2026-08-11T00:00:00.000Z',
      ...(selectionOverrides ?? {}),
    },
    resolved: null,
    summary: {
      title: 'Black satin midi dress',
      subtitle: 'Dresses',
      imageUri: 'file:///thumb.jpg',
      itemCount: 1,
      ...(summaryOverrides ?? {}),
    },
    fashionContext: context(),
    identificationState: 'ready',
    closetState: 'not_saved',
    closetItemId: null,
    ...rest,
  };
}

const OWNED_ID = '11111111-2222-4333-8444-555555555555';

// ── Contract source assertions ───────────────────────────────────────────────

test('the source of truth for the active item is the existing attachment store', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /resolveActiveItemContext\(chatAttachments\.attachments\)/);
  assert.doesNotMatch(
    screen,
    /useState[^\n]*activeItem/i,
    'the active item must be derived, not a second state store',
  );

  // Actor/logout invalidation is inherited rather than reimplemented.
  const auth = read('contexts/AuthSessionContext.tsx');
  assert.match(auth, /resetAttachmentStore\(\)/);
  const store = read('services/style-chat/styleChatAttachmentStore.ts');
  assert.match(store, /export function resetAttachmentStore[\s\S]*drafts\.clear\(\)/);
});

test('a send keeps the candidate-backed draft instead of removing it', () => {
  // This is why the context survives "ask a question" and stays visible for the
  // follow-ups; without it the loop would end at the first answer.
  const hook = read('hooks/useStyleChatAttachments.ts');
  assert.match(
    hook,
    /if \(!live\.selection\.closetCandidateId && state === 'sent'\) \{\s*removeDraftAttachment/,
  );
});

test('the context bar renders no identifier and no image path', () => {
  const bar = read('components/style-chat/StyleChatActiveItemBar.tsx');
  for (const forbidden of ['closetItemId', 'closetCandidateId', 'candidateId', 'actorId', 'sourceId']) {
    assert.doesNotMatch(bar, new RegExp(forbidden), `${forbidden} must not reach the context bar`);
  }
  // The only identifier it may touch is the composer-local draft id, and only
  // through the context object it is handed.
  assert.match(bar, /EliseActiveItemContext/);
});

// ── Selection ────────────────────────────────────────────────────────────────

test('an identified attachment becomes the visible active item', () => {
  const active = loop.resolveActiveItemContext([draft()]);
  assert.ok(active);
  assert.equal(active.draftId, 'att_1');
  assert.equal(active.title, 'Black satin midi dress');
  assert.equal(active.thumbnailUri, 'file:///thumb.jpg');
  assert.equal(active.categoryBucket, 'dress');
  assert.equal(active.owned, false);
  assert.equal(loop.describeClosetState(active), 'Not saved to Closet');
});

test('the same drafts always resolve to the same context', () => {
  // Rerenders and background/foreground cycles change neither the drafts nor the
  // result: the context is a pure function of state, so there is nothing to lose.
  const drafts = [draft()];
  assert.deepEqual(
    loop.resolveActiveItemContext(drafts),
    loop.resolveActiveItemContext(drafts),
  );
});

test('the context survives every state a sent attachment passes through', () => {
  for (const state of ['ready', 'sending', 'sent', 'send_failed']) {
    const active = loop.resolveActiveItemContext([draft({ state })]);
    assert.ok(active, `${state} must keep the active item visible`);
    assert.equal(active.attachmentState, state);
  }
});

test('an attachment that has not finished identifying is not presented as context', () => {
  for (const state of ['selected', 'sanitizing', 'identifying', 'creating_record', 'cancelled', 'rejected']) {
    assert.equal(
      loop.resolveActiveItemContext([draft({ state })]),
      null,
      `${state} must not claim a grounding it does not have`,
    );
  }
});

test('clearing removes it and replacing changes it', () => {
  const first = draft();
  const second = draft({
    draftId: 'att_2',
    summary: { title: 'Navy blazer', subtitle: 'Outerwear' },
    fashionContext: context({ category: 'Outerwear', subtype: 'blazer' }),
  });

  // Clear === the draft is gone from the store.
  assert.equal(loop.resolveActiveItemContext([]), null);

  // Replace === the newest usable direct-image draft wins, deterministically.
  const active = loop.resolveActiveItemContext([first, second]);
  assert.equal(active.draftId, 'att_2');
  assert.equal(active.title, 'Navy blazer');
  assert.equal(active.categoryBucket, 'outerwear');
});

test('a non-direct-image attachment never becomes the active item', () => {
  // A Closet item or a Look attached from the picker has no candidate backing
  // and is not "the photo Elise is looking at".
  const closetPick = draft({
    draftId: 'att_closet',
    selection: { closetCandidateId: null, closetCandidateBatchId: null },
    fashionContext: undefined,
  });
  assert.equal(loop.resolveActiveItemContext([closetPick]), null);
});

// ── Ownership ────────────────────────────────────────────────────────────────

test('an unsaved candidate is not an owned item', () => {
  for (const closetState of ['not_saved', 'saving', 'save_failed']) {
    const active = loop.resolveActiveItemContext([draft({ closetState })]);
    assert.equal(active.owned, false, `${closetState} is not ownership`);
    assert.notEqual(loop.describeClosetState(active), 'Saved to Closet');
  }
});

test('saved without a committed Closet id is not ownership either', () => {
  const active = loop.resolveActiveItemContext([
    draft({ closetState: 'saved', closetItemId: null }),
  ]);
  assert.equal(active.owned, false);
  assert.equal(loop.resolveStyleTarget([draft({ closetState: 'saved', closetItemId: '  ' })], 'att_1'), null);
});

test('ownership requires the persistence contract to have reported both', () => {
  const saved = draft({ closetState: 'saved', closetItemId: OWNED_ID });
  const active = loop.resolveActiveItemContext([saved]);
  assert.equal(active.owned, true);
  assert.equal(loop.describeClosetState(active), 'Saved to Closet');
  // Field-by-field: an object built inside the transpile sandbox is not
  // reference-equal to a test-realm literal, so deepEqual would fail on realm
  // identity rather than on value.
  const target = loop.resolveStyleTarget([saved], 'att_1');
  assert.equal(target.draftId, 'att_1');
  assert.equal(target.closetItemId, OWNED_ID);
});

// ── Labelling ────────────────────────────────────────────────────────────────

test('the label falls back through reviewed title, identity, then a neutral literal', () => {
  const reviewed = loop.resolveActiveItemContext([draft()]);
  assert.equal(reviewed.title, 'Black satin midi dress');

  const identified = loop.resolveActiveItemContext([
    draft({ summary: { title: '   ', subtitle: null, imageUri: null } }),
  ]);
  assert.equal(identified.title, 'midi dress');

  const nameless = loop.resolveActiveItemContext([
    draft({ summary: { title: '', subtitle: null, imageUri: null }, fashionContext: null }),
  ]);
  assert.equal(nameless.title, 'This photo');
  assert.equal(nameless.thumbnailUri, null);
});

test('a malformed persisted context is never rendered as a confident label', () => {
  const active = loop.resolveActiveItemContext([
    draft({
      summary: { title: '', subtitle: null, imageUri: null },
      fashionContext: { contractVersion: 'nope', items: [] },
    }),
  ]);
  assert.equal(active.title, 'This photo');
  assert.equal(active.categoryBucket, 'other');
});

test('the category comes from the repository vocabulary, not a new taxonomy', () => {
  const module = read('services/style-chat/eliseImageStylingLoop.ts');
  assert.match(module, /import \{ bucketForCategory \} from '\.\.\/free-tier\/outfitGenerator'/);

  // Subtype beats category, exactly as privateDressingRoomSlots.ts orders them.
  const blazer = loop.resolveActiveItemContext([
    draft({
      summary: { title: 'Cropped blazer', subtitle: 'Tops', imageUri: null },
      fashionContext: context({ category: 'Tops', subtype: 'blazer' }),
    }),
  ]);
  assert.equal(blazer.categoryBucket, 'outerwear');
});
