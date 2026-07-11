// Elise attachment media-recovery saga: draft-store crash/recovery hardening.
//
// Root cause guarded here: a late resolution/upload/finalization completion that
// lands AFTER the user removed the attachment (or after a send cleared the
// draft, or after an account switch) must never resurrect a "ghost" attachment.
// The store's update-only transition (updateDraftAttachment) is the single seam
// that enforces this; the hook routes every post-insert saga transition through
// it while genuine inserts stay on upsertDraftAttachment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false, console, Date, JSON, exports: mod.exports, module: mod,
    require: (spec) => {
      if (spec in requireMap) return requireMap[spec];
      throw new Error(`Unexpected import in ${relativePath}: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const store = loadTsModule('services/style-chat/styleChatAttachmentStore.ts', {
  '../../types/styleChatAttachments': {},
});

const S = 'saga-session';
const uploadingDraft = (draftId) => ({
  draftId,
  state: 'uploading_media',
  selection: { retryCount: 0, updatedAt: new Date().toISOString() },
  resolved: null,
  summary: { title: 'Blazer', itemCount: 1 },
});
const readyContract = (draftId, sourceId) => ({
  ...uploadingDraft(draftId),
  state: 'ready',
  resolved: {
    attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId,
    contractVersion: '2',
  },
});

// ── update-only transition semantics ──────────────────────────────────────────

test('updateDraftAttachment updates an existing draft and reports applied', () => {
  store.clearDraftAttachments(S);
  store.upsertDraftAttachment(S, uploadingDraft('d1'));
  const applied = store.updateDraftAttachment(S, readyContract('d1', '11111111-1111-4111-8111-111111111111'));
  assert.equal(applied, true);
  const [entry] = store.getDraftAttachments(S);
  assert.equal(entry.state, 'ready');
  assert.equal(entry.resolved.sourceId, '11111111-1111-4111-8111-111111111111');
  store.clearDraftAttachments(S);
});

test('removal invalidates a late completion: no ghost attachment is resurrected', () => {
  store.clearDraftAttachments(S);
  // Saga inserts the draft and begins uploading.
  store.upsertDraftAttachment(S, uploadingDraft('d1'));
  assert.equal(store.getDraftAttachments(S).length, 1);
  // User removes the attachment mid-upload.
  store.removeDraftAttachment(S, 'd1');
  assert.equal(store.getDraftAttachments(S).length, 0);
  // Upload + finalization complete LATE and try to mark ready.
  const applied = store.updateDraftAttachment(S, readyContract('d1', '22222222-2222-4222-8222-222222222222'));
  assert.equal(applied, false, 'late completion must not apply');
  assert.equal(store.getDraftAttachments(S).length, 0, 'removed attachment must not reappear');
  store.clearDraftAttachments(S);
});

test('a send that cleared the draft cannot be overwritten by a late finalization', () => {
  store.clearDraftAttachments(S);
  store.upsertDraftAttachment(S, uploadingDraft('d1'));
  // Send succeeds and clears the composer draft.
  store.clearDraftAttachments(S);
  // A straggler finalization arrives after the clear.
  const applied = store.updateDraftAttachment(S, readyContract('d1', '33333333-3333-4333-8333-333333333333'));
  assert.equal(applied, false);
  assert.equal(store.getDraftAttachments(S).length, 0);
});

test('obsolete operation cannot overwrite the current re-added attachment', () => {
  store.clearDraftAttachments(S);
  // Original attachment d1 begins resolving.
  store.upsertDraftAttachment(S, uploadingDraft('d1'));
  // User removes it, then re-adds the same item — a NEW draftId d2 is minted.
  store.removeDraftAttachment(S, 'd1');
  store.upsertDraftAttachment(S, uploadingDraft('d2'));
  store.updateDraftAttachment(S, readyContract('d2', '44444444-4444-4444-8444-444444444444'));
  // The obsolete d1 saga completes and tries to write a stale state.
  const applied = store.updateDraftAttachment(S, {
    ...readyContract('d1', '55555555-5555-4555-8555-555555555555'),
    state: 'failed_retryable',
  });
  assert.equal(applied, false);
  const entries = store.getDraftAttachments(S);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].draftId, 'd2');
  assert.equal(entries[0].state, 'ready');
  assert.equal(entries[0].resolved.sourceId, '44444444-4444-4444-8444-444444444444');
  store.clearDraftAttachments(S);
});

test('update-only never creates a draft for an unknown session', () => {
  assert.equal(store.updateDraftAttachment('never-seen-session', readyContract('x', '66666666-6666-4666-8666-666666666666')), false);
  assert.equal(store.getDraftAttachments('never-seen-session').length, 0);
});

// ── actor isolation ───────────────────────────────────────────────────────────

test('resetAttachmentStore drops all drafts and any un-consumed handoff', () => {
  store.upsertDraftAttachment('user-a-session', readyContract('a1', '77777777-7777-4777-8777-777777777777'));
  store.setAttachmentHandoff({
    resolved: readyContract('h', '88888888-8888-4888-8888-888888888888').resolved,
    summary: { title: 'Coat', itemCount: 1 },
    createdAt: new Date().toISOString(),
  });
  assert.equal(store.getDraftAttachments('user-a-session').length, 1);
  assert.ok(store.peekAttachmentHandoff());

  store.resetAttachmentStore();

  assert.equal(store.getDraftAttachments('user-a-session').length, 0);
  assert.equal(store.peekAttachmentHandoff(), null);
});

// ── wiring guarantees (structural) ────────────────────────────────────────────

test('the hook routes saga transitions through update-only, inserts through upsert', () => {
  const hook = read('hooks/useStyleChatAttachments.ts');
  // Saga transition states must be reached via updateDraftAttachment.
  for (const state of ['creating_record', 'uploading_media', 'rejected']) {
    const re = new RegExp(`updateDraftAttachment\\(sessionId, \\{[\\s\\S]{0,120}state: '${state}'`);
    assert.match(hook, re, `saga must use updateDraftAttachment for ${state}`);
  }
  // A captured draft (…draft) must NEVER be re-written via upsert: that is
  // exactly the ghost-resurrection path. Every …draft transition is update-only.
  assert.ok(!/upsertDraftAttachment\(sessionId, \{\s*\.\.\.draft/.test(hook),
    'a captured ...draft must never be upserted (would resurrect removed drafts)');
  assert.match(hook, /updateDraftAttachment\(sessionId, \{\s*\n\s*\.\.\.draft/,
    'saga transitions must spread the captured draft into update-only');
  // Initial inserts (addOwnedItem) still use upsert with the freshly built draft.
  assert.match(hook, /upsertDraftAttachment\(sessionId, draft\)/);
});

test('auth actor changes reset the attachment store', () => {
  const auth = read('contexts/AuthSessionContext.tsx');
  assert.match(auth, /resetAttachmentStore/);
  // Reset is co-located with memory-cache invalidation on non-refresh events.
  assert.match(auth, /invalidateAllMemoryCache\(\);\s*[\s\S]{0,240}resetAttachmentStore\(\)/);
});
