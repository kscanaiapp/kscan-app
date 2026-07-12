// Phase 2 — mobile attachment state machine, draft store, photo intake, and
// entry-point behavior. Pure store logic runs in the VM harness; hook/screen
// behavior that requires a React renderer is verified structurally.

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

const hookSource = read('hooks/useStyleChatAttachments.ts');
const chatHookSource = read('hooks/useStyleChat.ts');
const intakeSource = read('components/style-chat/StyleChatPhotoIntake.tsx');
const barSource = read('components/style-chat/StyleChatAttachmentBar.tsx');
const screenSource = read('app/style-chat/[sessionId].tsx');

const S = 'session-1';
const readyDraft = (draftId, sourceId) => ({
  draftId,
  state: 'ready',
  summary: { title: 'Blazer', kind: 'owned_item' },
  resolved: {
    attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId, contractVersion: '2',
  },
});

// ── Draft store ───────────────────────────────────────────────────────────────

test('empty attachment snapshots are stable for useSyncExternalStore', () => {
  store.resetAttachmentStore();
  const first = store.getDraftAttachments('empty-session');
  const second = store.getDraftAttachments('empty-session');

  assert.equal(first.length, 0);
  assert.equal(second.length, 0);
  assert.equal(first, second, 'empty sessions must not return a fresh array per snapshot read');

  store.clearDraftAttachments('empty-session');
  assert.equal(store.getDraftAttachments('empty-session'), first);
});

test('drafts survive by session; snapshot returns only ready, immutable copies', () => {
  store.clearDraftAttachments(S);
  store.upsertDraftAttachment(S, readyDraft('d1', '11111111-1111-4111-8111-111111111111'));
  store.upsertDraftAttachment(S, { draftId: 'd2', state: 'uploading_media', summary: { title: 'P' } });
  store.upsertDraftAttachment(S, { draftId: 'd3', state: 'failed_retryable', summary: { title: 'F' } });

  const snapshot = store.snapshotReadyAttachments(S);
  assert.equal(snapshot.references.length, 1); // uploading + failed excluded
  assert.equal(snapshot.references[0].sourceId, '11111111-1111-4111-8111-111111111111');

  // Post-snapshot mutation cannot touch the in-flight copy.
  store.removeDraftAttachment(S, 'd1');
  assert.equal(snapshot.references.length, 1);
  snapshot.references[0].sourceId = 'tampered';
  assert.equal(store.snapshotReadyAttachments(S).references.length, 0);

  // Other sessions are isolated.
  assert.equal(store.getDraftAttachments('other-session').length, 0);
  store.clearDraftAttachments(S);
});

test('composer text preserved across remounts; clear on send unless keepText', () => {
  store.setDraftComposerText(S, 'which shoes work with this?');
  assert.equal(store.getDraftComposerText(S), 'which shoes work with this?');
  store.upsertDraftAttachment(S, readyDraft('d9', '22222222-2222-4222-8222-222222222222'));
  store.clearDraftAttachments(S, { keepText: true });
  assert.equal(store.getDraftAttachments(S).length, 0);
  assert.equal(store.getDraftComposerText(S), 'which shoes work with this?');
  store.clearDraftAttachments(S);
  assert.equal(store.getDraftComposerText(S), '');
});

test('entry handoff is one-time and never auto-sends', () => {
  store.setAttachmentHandoff({
    resolved: readyDraft('h', '33333333-3333-4333-8333-333333333333').resolved,
    summary: { title: 'Blazer', kind: 'owned_item' },
    createdAt: new Date().toISOString(),
  });
  assert.ok(store.peekAttachmentHandoff());
  const first = store.consumeAttachmentHandoff();
  assert.ok(first);
  assert.equal(store.consumeAttachmentHandoff(), null); // consumed exactly once
  // Handoff enters the composer as a draft; nothing in the store sends.
  const storeSource = read('services/style-chat/styleChatAttachmentStore.ts');
  assert.doesNotMatch(storeSource, /sendMessage|fetch\(|supabase/);
});

test('failed listener never corrupts the store', () => {
  const unsubscribe = store.subscribeToAttachmentDrafts(() => { throw new Error('boom'); });
  let called = 0;
  const unsubscribe2 = store.subscribeToAttachmentDrafts(() => { called += 1; });
  store.upsertDraftAttachment(S, readyDraft('dx', '44444444-4444-4444-8444-444444444444'));
  assert.ok(called >= 1);
  unsubscribe();
  unsubscribe2();
  store.clearDraftAttachments(S);
});

// ── State machine (hook, structural) ──────────────────────────────────────────

test('attachment lifecycle covers required states; failed is retryable and removable', () => {
  const contract = read('types/styleChatAttachments.ts');
  for (const state of ['selected', 'sanitizing', 'identifying', 'awaiting_review',
    'creating_record', 'uploading_media', 'finalizing', 'ready', 'failed_retryable',
    'rejected', 'cancelled', 'unavailable']) {
    assert.ok(contract.includes(`'${state}'`), `missing state ${state}`);
  }
  assert.match(hookSource, /retryAttachment/);
  assert.match(hookSource, /removeAttachment/);
  // Send gating: only when every attachment is ready.
  assert.match(hookSource, /every\(\(entry\) => entry\.state === 'ready'/);
  // Failed resolution never sends a local-only reference.
  assert.match(hookSource, /'failed_retryable'/);
  assert.doesNotMatch(hookSource, /localImageUri[^\n]*resolved:/);
  assert.match(hookSource, /remoteSourceId/);
  assert.match(hookSource, /ensureSavedScanMediaBacking\(\{[\s\S]*savedScanId/);
});

test('resolution saga order: remote row first, then media backing; no invented UUIDs', () => {
  const remoteIdx = hookSource.indexOf('ensureRemoteBackedOwnedItem');
  const mediaIdx = hookSource.indexOf('ensureSavedScanMediaBacking');
  assert.ok(remoteIdx > 0 && mediaIdx > remoteIdx);
  assert.doesNotMatch(hookSource, /randomUUID|uuidv4|generateUuid/);
});

// ── Photo intake (structural) ─────────────────────────────────────────────────

test('photo intake keeps scanner protections: op id, abort, late-result discard, sanitizer', () => {
  assert.match(intakeSource, /operationIdRef/);
  assert.match(intakeSource, /AbortController/);
  assert.match(intakeSource, /!== operationIdRef\.current/); // stale results discarded
  assert.match(intakeSource, /sanitizeImageBeforeUpload/);
  assert.match(intakeSource, /identifyScanImage/);
  // Save-through-Closet is mandatory: attach only after saveScan + cloud sync.
  assert.match(intakeSource, /saveScan\(/);
  assert.match(intakeSource, /saveScanToCloud/);
  assert.match(intakeSource, /SAVE TO CLOSET & ATTACH/);
  // Failed identification still allows manual save; no auto-send anywhere.
  assert.match(intakeSource, /manual/i);
  assert.doesNotMatch(intakeSource, /sendMessage/);
});

test('scanner core is untouched (duplicate guard, operation ids, abort handling)', () => {
  // The intake composes existing scanner services; the scanner internals are
  // not modified by Phase 2. Spot-check the scanner hook still owns its guards.
  const scanner = read('hooks/useKScan.js');
  assert.match(scanner, /AbortController|abort/);
  assert.doesNotMatch(intakeSource, /useKScan\b/); // intake never rewires the scan-room hook
});

// ── Composer + send behavior (structural) ─────────────────────────────────────

test('send path: immutable snapshot per send, deferred persistence, draft restored on rejection', () => {
  assert.match(screenSource, /snapshotForSend/);
  assert.match(screenSource, /canSendWithAttachments/);
  assert.match(screenSource, /getDraftComposerText/);
  assert.match(screenSource, /setDraftComposerText/);
  assert.match(screenSource, /value=\{composerText\}/);
  assert.match(screenSource, /onChangeText=\{setComposerText\}/);
  assert.match(screenSource, /onSent:\s*\(\)\s*=>\s*\{[\s\S]*setComposerText\(''\)/);
  assert.match(screenSource, /retryAttachment\(draftId,\s*items,\s*localScans\)/);
  assert.match(chatHookSource, /deferUserPersistence/);
  assert.match(chatHookSource, /attachments_unsupported/);
  assert.match(chatHookSource, /attachments_rejected|ATTACHMENT_NOT_OWNED|LOOK_NOT_AVAILABLE/);
  assert.match(chatHookSource, /retryStateRef\.current\?\.remember\(\{[\s\S]*?attachments:\s*sendAttachments/);
  // Feature flag gates the attachment UI without touching baseline chat.
  assert.match(screenSource, /STYLECHAT_ATTACHMENTS_ENABLED|attachmentsEnabled/);
  const flags = read('constants/featureFlags.ts');
  assert.match(flags, /STYLECHAT_ATTACHMENTS_ENABLED/);
});

test('attachment bar reuses Closet/Look sources; no second outfit engine in StyleChat', () => {
  assert.match(barSource, /useOwnedClosetItems|listOwnedClosetItems/);
  assert.match(barSource, /useLooks|listLooks/);
  assert.match(barSource, /onRetry\(draft\.draftId,\s*closet\.items,\s*closet\.localScans/);
  // StyleChat never generates outfits itself — it routes to the shared stylist.
  for (const source of [barSource, screenSource, chatHookSource, hookSource]) {
    assert.ok(!source.includes('style-outfit-generate'), 'StyleChat must not call the outfit engine directly');
  }
  const cards = read('components/style-chat/StyleChatActionCards.tsx');
  assert.match(cards, /router\.(push|navigate)/); // actions navigate to the stylist instead
});

test('entry points hand off via the store and never auto-send', () => {
  for (const rel of ['app/looks/[id].tsx', 'app/stylist/index.tsx', 'app/library.tsx']) {
    const source = read(rel);
    if (source.includes('setAttachmentHandoff')) {
      assert.ok(!/setAttachmentHandoff[\s\S]{0,400}sendMessage/.test(source), `${rel} must not auto-send`);
    }
  }
  assert.match(read('app/looks/[id].tsx'), /setAttachmentHandoff/);
  assert.match(read('app/stylist/index.tsx'), /setAttachmentHandoff/);
});
