// Post-answer Closet progression (image styling loop, Commit 3).
//
// The repaired save is NOT redesigned here. These assert the properties the
// progression must not break:
//
//   * the save is optional — an unsaved attachment stays sendable, and the chat
//     and the follow-ups keep working whether or not it is ever saved
//   * a failure never returns the attachment to an unusable state
//   * a retry is candidate-idempotent, and a double tap is one promotion
//   * saving → saved is legible without an animation
//   * a save landing after the actor changed cannot write into the new actor
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
    attachmentState: 'sent',
    closetState: 'not_saved',
    owned: false,
    styled: false,
    ...overrides,
  };
}

const types = (actions) => Array.from(actions, (action) => action.type).join('|');

// ── The save stays optional ──────────────────────────────────────────────────

test('an unsaved attachment is still sendable and still gets follow-ups', () => {
  // The send gate is attachment state only. Closet state appears nowhere in it,
  // which is the attach-first invariant expressed as code.
  const hook = read('hooks/useStyleChatAttachments.ts');
  const gate =
    hook.match(/const allReady =([\s\S]*?)const canSendWithAttachments =[^\n]*\n/)?.[0] ?? '';
  assert.ok(gate, 'the send gate must exist');
  for (const forbidden of ['closetState', 'closetItemId', 'saved']) {
    assert.ok(!gate.includes(forbidden), `the send gate must not consult ${forbidden}`);
  }

  for (const closetState of ['not_saved', 'saving', 'save_failed']) {
    const actions = loop.resolveFollowUpActions(ctx({ closetState }));
    assert.ok(
      Array.from(actions).filter((action) => action.type === 'prompt').length >= 2,
      `${closetState} must keep its questions`,
    );
  }
});

test('a failed save leaves the attachment usable, not broken', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const apply =
    hook.match(/const applyClosetOutcome = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.ok(apply, 'applyClosetOutcome must exist');
  // It writes ONLY the Closet fields. `state` — the attachment lifecycle — is
  // spread through untouched, so a Closet failure cannot un-attach a photo.
  assert.match(apply, /\.\.\.live,/);
  assert.ok(!/\bstate:/.test(apply), 'a Closet outcome must never write attachment state');

  const actions = loop.resolveFollowUpActions(ctx({ closetState: 'save_failed' }));
  assert.equal(types(actions), 'prompt|prompt|save_to_closet');
  assert.equal(Array.from(actions)[2].label, 'Try again');
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test('a double tap on save produces one promotion', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const save =
    hook.match(/const saveDirectImageToCloset = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.ok(save, 'saveDirectImageToCloset must exist');
  // A module-level guard, not component state: it must survive a remount of the
  // screen mid-save.
  assert.match(hook, /^const savingClosetCandidateIds = new Set<string>\(\);$/m);
  assert.match(save, /if \(savingClosetCandidateIds\.has\(candidateId\)\) return \{ ok: true \}/);
  assert.match(save, /if \(draft\.closetState === 'saved'\) return \{ ok: true \}/);
  assert.match(save, /savingClosetCandidateIds\.delete\(candidateId\)/);
});

test('a retry reuses the same candidate rather than creating a second one', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const save =
    hook.match(/const saveDirectImageToCloset = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.match(save, /candidateIds: \[candidateId\]/);
  assert.ok(!save.includes('createClosetCandidate'), 'a retry must not mint a new candidate');
  // Promotion is idempotent by candidate identity on the store side.
  assert.match(save, /item\?\.status === 'promoted' \|\| item\?\.status === 'already_promoted'/);
});

test('the screen saves through that one function and reports failure honestly', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.equal(
    (screen.match(/saveDirectImageToCloset\(/g) ?? []).length,
    2,
    'the chip and the follow-up both call the one save; nothing else does',
  );
  const handler =
    screen.match(/const handleSaveActiveItemToCloset = useCallback\(([\s\S]*?)\n  \}, /)?.[1] ?? '';
  assert.match(handler, /if \(!result\.ok\) Alert\.alert\('Closet', result\.message\)/);
});

// ── Transition legibility ────────────────────────────────────────────────────

test('every save state has distinct, honest copy', () => {
  const seen = new Map();
  for (const closetState of ['not_saved', 'saving', 'saved', 'save_failed']) {
    const owned = closetState === 'saved';
    const line = loop.describeClosetState(ctx({ closetState, owned }));
    assert.ok(line && line.trim(), `${closetState} needs a line`);
    assert.ok(!seen.has(line), `${closetState} must not reuse "${line}"`);
    seen.set(line, closetState);
  }
  // Only the genuinely saved state may claim the Closet.
  assert.equal(loop.describeClosetState(ctx({ closetState: 'saved', owned: true })), 'Saved to Closet');
  assert.equal(loop.describeClosetState(ctx({ closetState: 'saving' })), 'Saving to Closet…');
  assert.equal(loop.describeClosetState(ctx({ closetState: 'save_failed' })), "Couldn't save to Closet");
});

test('success is carried by text, not by an animation', () => {
  const bar = read('components/style-chat/StyleChatActiveItemBar.tsx');
  assert.match(bar, /describeClosetState\(context\)/);
  assert.match(bar, /saved \? `\$\{closetLine\} ✓` : closetLine/);
  for (const forbidden of ['Animated', 'LayoutAnimation', 'useNativeDriver']) {
    assert.ok(!bar.includes(forbidden), `state must not depend on ${forbidden}`);
  }
});

test('a saved item progresses to Style This Item', () => {
  const before = loop.resolveFollowUpActions(ctx({ closetState: 'not_saved' }));
  const after = loop.resolveFollowUpActions(ctx({ closetState: 'saved', owned: true }));
  assert.ok(!types(before).includes('style_this_item'));
  assert.ok(types(after).startsWith('style_this_item'));
  assert.ok(!types(after).includes('save_to_closet'), 'an owned item is not asked to save again');
});

// ── Actor safety ─────────────────────────────────────────────────────────────

test('a save landing after an actor change cannot write into the new actor', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const apply =
    hook.match(/const applyClosetOutcome = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  // Update-only by construction: the draft is looked up live and a miss returns.
  assert.match(apply, /const live = getDraftAttachments\(sessionId\)\.find\(/);
  assert.match(apply, /if \(!live\) return;/);

  // And an actor change empties the store the lookup reads.
  const store = read('services/style-chat/styleChatAttachmentStore.ts');
  assert.match(store, /export function resetAttachmentStore[\s\S]*drafts\.clear\(\)/);
  assert.match(read('contexts/AuthSessionContext.tsx'), /resetAttachmentStore\(\)/);
});

test('the save carries the current actor, not one captured at attach time', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const save =
    hook.match(/const saveDirectImageToCloset = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.match(save, /const actorRequest = createActorRequest\(\);/);
  assert.match(save, /actorId: actorRequest\.actorId/);
  assert.match(save, /actorEpoch: actorRequest\.epoch/);
});

test('an abandoned unsaved candidate is released, and a saved one is not', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  const remove = hook.match(/const removeAttachment = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.match(remove, /draft\.closetState !== 'saved'/);
  assert.match(remove, /deleteClosetCandidate\(createActorRequest\(\), candidateId\)/);
  // Replacing the active item goes through that same removal.
  const screen = read('app/style-chat/[sessionId].tsx');
  const change =
    screen.match(/const handleChangeActiveItem = useCallback\(([\s\S]*?)\n  \}, /)?.[1] ?? '';
  assert.match(change, /chatAttachments\.removeAttachment\(activeItem\.draftId\)/);
  assert.match(change, /setPhotoIntakeVisible\(true\)/);
});

test('ownership still requires both halves after every save path', () => {
  assert.equal(loop.resolveStyleTarget([], 'att_1'), null);
  const partial = [{
    draftId: 'att_1',
    state: 'sent',
    selection: { closetCandidateId: 'cand-1' },
    closetState: 'saved',
    closetItemId: null,
    summary: { title: 'x' },
  }];
  assert.equal(loop.resolveStyleTarget(partial, 'att_1'), null);
  const full = [{ ...partial[0], closetItemId: OWNED_ID }];
  assert.equal(loop.resolveStyleTarget(full, 'att_1').closetItemId, OWNED_ID);
});
