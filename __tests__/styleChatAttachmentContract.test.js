// Phase 2 — StyleChat attachment, media, and server v2 contract tests.
// TS transpiled in-process (existing harness pattern); Deno-free server
// modules unit-tested directly; index.ts checked statically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join('supabase', 'functions', 'stylechat-generate');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false, console, Date, exports: mod.exports, module: mod,
    require: (spec) => {
      if (spec in requireMap) return requireMap[spec];
      throw new Error(`Unexpected import in ${relativePath}: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const LOOK = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mobileContract = loadTsModule('types/styleChatAttachments.ts', {
  './fashionReasoning': {}, './ownedClosetItem': {},
});
const attachments = loadTsModule(path.join(FN, 'attachments.ts'));
const context = loadTsModule(path.join(FN, 'attachmentContext.ts'), {
  './attachments.ts': attachments,
});
const actions = loadTsModule(path.join(FN, 'actions.ts'), {
  './attachmentContext.ts': context,
});
const multimodal = loadTsModule(path.join(FN, 'multimodal.ts'), {
  './attachmentContext.ts': context,
});
const indexSource = fs.readFileSync(path.join(ROOT, FN, 'index.ts'), 'utf8');
const mediaMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260712000001_saved_scan_media_backing.sql'), 'utf8');
const auditMigrationFile = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_audit_hardening_ai_stylist_stylechat.sql'));
assert.ok(auditMigrationFile, 'audit hardening migration missing');
const auditMigration = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', auditMigrationFile), 'utf8');
const rolePrivilegeMigrationFile = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_harden_app_role_privileges.sql'));
assert.ok(rolePrivilegeMigrationFile, 'role privilege hardening migration missing');
const rolePrivilegeMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', rolePrivilegeMigrationFile), 'utf8');
const mediaService = fs.readFileSync(path.join(ROOT, 'services', 'savedScanMedia.ts'), 'utf8');
const deletionScript = fs.readFileSync(path.join(ROOT, 'scripts', 'process-deletion-request.js'), 'utf8');

// ── Ancestry (Phase 1 migrations preserved) ───────────────────────────────────

test('Phase 1 migrations and outfit-decision constraints remain present', () => {
  for (const file of [
    '20260711000001_ai_stylist_looks_extension.sql',
    '20260711000002_outfit_decision_rooms.sql',
    '20260711000003_style_outfit_usage.sql',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'supabase', 'migrations', file)), `${file} missing`);
  }
  const decisions = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260711000002_outfit_decision_rooms.sql'), 'utf8');
  assert.match(decisions, /unique \(group_id, user_id\)/);
  assert.match(decisions, /share_looks_to_outfit_decision/);
});

// ── Attachment contract + limits ──────────────────────────────────────────────

test('valid saved_scan / inspiration_item / look / outfit_draft parse; invalid types rejected', () => {
  const ok = attachments.parseStyleChatAttachments([
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A },
    { attachmentType: 'owned_item', sourceType: 'inspiration_item', sourceId: B },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.attachments.length, 2);

  assert.equal(attachments.parseStyleChatAttachments([{ attachmentType: 'look', lookId: LOOK }]).ok, true);
  assert.equal(
    attachments.parseStyleChatAttachments([
      { attachmentType: 'outfit_draft', itemRefs: [
        { sourceType: 'saved_scan', sourceId: A }, { sourceType: 'saved_scan', sourceId: B },
      ] },
    ]).ok, true);
  assert.equal(attachments.parseStyleChatAttachments([{ attachmentType: 'retail_product', sourceId: A }]).ok, false);
  assert.equal(attachments.parseStyleChatAttachments([{ attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: 'local-123' }]).ok, false);
});

test('limits: >3 owned items, duplicate, look+draft, ambiguous combos rejected', () => {
  const four = [A, B, C, LOOK].map((id) => ({ attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: id }));
  assert.equal(attachments.parseStyleChatAttachments(four).errorCode, 'ATTACHMENT_LIMIT_EXCEEDED');
  const dup = attachments.parseStyleChatAttachments([
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A },
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A.toUpperCase() },
  ]);
  assert.equal(dup.ok, false);
  const both = attachments.parseStyleChatAttachments([
    { attachmentType: 'look', lookId: LOOK },
    { attachmentType: 'outfit_draft', itemRefs: [
      { sourceType: 'saved_scan', sourceId: A }, { sourceType: 'saved_scan', sourceId: B }] },
  ]);
  assert.equal(both.errorCode, 'ATTACHMENT_LIMIT_EXCEEDED');
  // Mobile combination validator agrees (client mirror).
  const clientCombo = mobileContract.validateAttachmentCombination([
    { attachment: { attachmentType: 'look', lookId: LOOK, contractVersion: '2' }, itemCount: 5 },
    { attachment: { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A, contractVersion: '2' }, itemCount: 1 },
    { attachment: { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: B, contractVersion: '2' }, itemCount: 1 },
  ]);
  assert.equal(clientCombo.ok, false); // look + >1 owned item is ambiguous
});

test('outfit draft creates no database table', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'));
  for (const file of migrations) {
    const content = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', file), 'utf8');
    assert.ok(!/create table[^;]*outfit_draft/i.test(content), `${file} creates an outfit_draft table`);
  }
});

// ── Authorization / resolution ────────────────────────────────────────────────

function makeDataSource(rows = {}) {
  return {
    fetchSavedScans: async (ids) => (rows.scans ?? []).filter((row) => ids.includes(row.id)),
    fetchInspirationItems: async (ids) => (rows.inspirations ?? []).filter((row) => ids.includes(row.id)),
    fetchLook: async (lookId) => (rows.look && rows.look.id === lookId ? rows.look : null),
    fetchLookItems: async () => rows.lookItems ?? [],
  };
}

const scanRow = (id, extra = {}) => ({
  id, title: 'Blazer', analysis_result: { metadata: { category: 'Blazer', color: 'Navy' } },
  user_id: USER,
  storage_bucket: 'style-library-images',
  storage_path: `${USER}/saved-scans/${id}.jpg`,
  media_status: 'ready',
  ...extra,
});

test('owned item accepted; foreign/deleted/missing rejected with one safe error', async () => {
  const parse = attachments.parseStyleChatAttachments([
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A }]);
  const ok = await context.resolveStyleChatAttachments(parse.attachments, makeDataSource({ scans: [scanRow(A)] }));
  assert.equal(ok.ok, true);
  // Foreign: the user-scoped query returns nothing → ATTACHMENT_NOT_OWNED
  // regardless of whether the row exists for another user (no existence leak).
  const foreign = await context.resolveStyleChatAttachments(
    attachments.parseStyleChatAttachments([
      { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: FOREIGN }]).attachments,
    makeDataSource({ scans: [scanRow(A)] }),
  );
  assert.equal(foreign.ok, false);
  assert.equal(foreign.errorCode, 'ATTACHMENT_NOT_OWNED');
});

test('saved-scan ready media is ignored unless bucket/path match the owner contract', async () => {
  const parse = attachments.parseStyleChatAttachments([
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A }]);
  const poisoned = await context.resolveStyleChatAttachments(
    parse.attachments,
    makeDataSource({
      scans: [scanRow(A, { storage_path: `${FOREIGN}/saved-scans/${A}.jpg` })],
    }),
  );
  assert.equal(poisoned.ok, true);
  assert.equal(poisoned.resolved[0].items[0].media, null);
  assert.equal(multimodal.selectImagesForInspection(poisoned.resolved).length, 0);
});

test('foreign/missing Look rejected; valid Look resolves ordered items', async () => {
  const missing = await context.resolveStyleChatAttachments(
    attachments.parseStyleChatAttachments([{ attachmentType: 'look', lookId: LOOK }]).attachments,
    makeDataSource({}),
  );
  assert.equal(missing.errorCode, 'LOOK_NOT_AVAILABLE');
  const okLook = await context.resolveStyleChatAttachments(
    attachments.parseStyleChatAttachments([{ attachmentType: 'look', lookId: LOOK }]).attachments,
    makeDataSource({
      look: { id: LOOK, title: 'Date Night', occasion: 'date' },
      lookItems: [
        { id: 'x', snapshot_payload: { title: 'Top', category: 'Top' }, sort_order: 0, source_saved_scan_id: A },
        { id: 'y', snapshot_payload: { title: 'Shoes', category: 'Heels' }, sort_order: 1, source_saved_scan_id: B },
      ],
    }),
  );
  assert.equal(okLook.ok, true);
  assert.equal(okLook.resolved[0].items.length, 2);
});

test('mixed valid/invalid outfit draft rejected atomically', async () => {
  const parse = attachments.parseStyleChatAttachments([
    { attachmentType: 'outfit_draft', itemRefs: [
      { sourceType: 'saved_scan', sourceId: A }, { sourceType: 'saved_scan', sourceId: FOREIGN }] },
  ]);
  const result = await context.resolveStyleChatAttachments(parse.attachments, makeDataSource({ scans: [scanRow(A)] }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ATTACHMENT_NOT_OWNED');
});

test('request-body user id is never read by the v2 modules or handler', () => {
  const sources = ['attachments.ts', 'attachmentContext.ts', 'actions.ts', 'multimodal.ts', 'index.ts']
    .map((file) => fs.readFileSync(path.join(ROOT, FN, file), 'utf8'));
  for (const source of sources) {
    assert.ok(!/body\.(userId|user_id)/.test(source));
  }
});

// ── V1/V2 compatibility ───────────────────────────────────────────────────────

test('v1 requests: no contractVersion required; attachment-free prompt unchanged; v2 detection exact', () => {
  assert.match(indexSource, /npm:@supabase\/supabase-js@2\.105\.4/);
  assert.equal(attachments.isV2StyleChatRequest({ sessionId: 's', message: 'hello' }), false);
  assert.equal(attachments.isV2StyleChatRequest({ sessionId: 's', message: 'hi', attachments: [] }), false);
  assert.equal(attachments.isV2StyleChatRequest({ contractVersion: '2', message: 'hi' }), true);
  assert.equal(attachments.isV2StyleChatRequest({ message: 'hi', attachments: [{}] }), true);
  // Prompt extension only applies when verified attachments exist.
  assert.match(indexSource, /resolvedAttachments\.length > 0 \? buildAttachmentContextBlock/);
  // V1 response shape untouched; v2 adds capabilities signal.
  assert.match(indexSource, /if \(!isV2Request\) \{\s*return json\(\{\s*status: usedFallback/);
  assert.match(indexSource, /capabilities: \['attachments', 'structured_actions'\]/);
  assert.match(indexSource, /select\('id,user_id,title,analysis_result,storage_bucket,storage_path,media_status'\)/);
  assert.match(indexSource, /select\('id,user_id,note,category,color,pattern,material,silhouette,garment_role,storage_bucket,storage_path'\)/);
  // Attachment resolution sits after the burst guard, before daily quota.
  assert.ok(indexSource.indexOf('check_and_increment_stylechat_burst') <
    indexSource.indexOf('4c. V2 attachment resolution'));
  assert.ok(indexSource.indexOf('4c. V2 attachment resolution') <
    indexSource.indexOf(".rpc('increment_stylechat_daily_usage')"));
});

test('client capability handling: unsupported v2 preserves the draft, never strips attachments', () => {
  const provider = fs.readFileSync(
    path.join(ROOT, 'services', 'style-chat', 'providers', 'edgeStyleChatProvider.ts'), 'utf8');
  assert.match(provider, /attachments_unsupported/);
  assert.match(provider, /raw\.contractVersion !== STYLECHAT_ATTACHMENT_CONTRACT_VERSION/);
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  assert.match(hook, /Closet-aware messaging isn't available yet\. Your attachments are still here\./);
  assert.match(hook, /deferUserPersistence = skipUserPersistence \|\| hasAttachments/);
});

// ── Context builder redaction + bounds ────────────────────────────────────────

test('context block excludes user ids, storage paths, signed URLs, analysis_result, products', async () => {
  const resolution = await context.resolveStyleChatAttachments(
    attachments.parseStyleChatAttachments([
      { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A }]).attachments,
    makeDataSource({ scans: [scanRow(A, { user_id: 'secret-user', products: [{ url: 'https://x' }] })] }),
  );
  const block = context.buildAttachmentContextBlock(resolution.resolved);
  assert.ok(!block.includes('secret-user'));
  assert.ok(!block.includes('style-library-images'));
  assert.ok(!block.includes('saved-scans/'));
  assert.ok(!/signed|token=/i.test(block));
  assert.ok(!block.includes('analysis_result'));
  assert.ok(!block.includes('products'));
  assert.ok(!/data:image|base64/i.test(block));
  assert.match(block, /ref:saved_scan:/); // opaque action reference present
});

test('context is bounded to 4000 chars with whole-line truncation; hint bounded to 200', async () => {
  assert.equal(context.MAX_ATTACHMENT_CONTEXT_CHARS, 4000);
  assert.equal(context.MAX_CONTEXT_HINT_CHARS, 200);
  const longScans = Array.from({ length: 6 }, (_, i) =>
    scanRow(`${i}1111111-1111-4111-8111-11111111111${i}`.slice(0, 36), {
      title: 'X'.repeat(400), analysis_result: { metadata: { category: 'Blazer '.repeat(40) } },
    }));
  const resolution = await context.resolveStyleChatAttachments(
    attachments.parseStyleChatAttachments(
      longScans.slice(0, 3).map((row) => ({ attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: row.id })),
    ).attachments,
    makeDataSource({ scans: longScans }),
  );
  const block = context.buildAttachmentContextBlock(resolution.resolved);
  assert.ok(block.length <= 4000);
  assert.ok(block.endsWith('[/Attached]')); // structure never broken
  const hint = context.normalizeContextHint(`<b>hi</b> ${'x'.repeat(500)}\u0000`);
  assert.ok(hint.length <= 200);
  assert.ok(!hint.includes('<'));
});

// ── Multimodal rules ──────────────────────────────────────────────────────────

test('multimodal: heuristic-gated, max two images, non-ready media excluded, MIME allowlist', async () => {
  assert.equal(multimodal.MAX_MULTIMODAL_IMAGES, 2);
  assert.equal(multimodal.requiresImageInspection('do these exact colors work together?'), true);
  assert.equal(multimodal.requiresImageInspection('what should I wear tomorrow'), false);
  const resolution = await context.resolveStyleChatAttachments(
    attachments.parseStyleChatAttachments([
      { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: A },
      { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: B },
      { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: C },
    ]).attachments,
    makeDataSource({ scans: [scanRow(A), scanRow(B), scanRow(C, { media_status: 'pending' })] }),
  );
  const selected = multimodal.selectImagesForInspection(resolution.resolved);
  assert.equal(selected.length, 2); // C excluded (not ready); max 2 anyway
  assert.equal(multimodal.isAllowedMultimodalMime('image/jpeg'), true);
  assert.equal(multimodal.isAllowedMultimodalMime('image/svg+xml'), false);
  // Bytes never logged; signed URLs never exposed to the client response.
  assert.ok(!/console\.[a-z]+\([^)]*inline_data/.test(indexSource));
  assert.ok(!/signedUrl/i.test(indexSource.slice(indexSource.indexOf('multimodal'))));
});

// ── Structured actions ────────────────────────────────────────────────────────

const resolvedFixture = [
  { attachmentType: 'owned_item', items: [{ ref: { sourceType: 'saved_scan', sourceId: A }, title: 'Blazer', category: 'Blazer', role: 'outerwear', color: null, pattern: null, material: null, silhouette: null, fit: null, brand: null, styleTags: [], media: null }] },
  { attachmentType: 'look', lookId: LOOK, title: 'Date', occasion: null, dressCode: null, setting: null, items: [] },
];

test('allowlisted action accepted; unknown/invented/foreign/placeholder dropped; text preserved', () => {
  const extracted = actions.extractActionsBlock(
    `Happy to help. <actions>${JSON.stringify([
      { type: 'style_anchor_item', anchor: { sourceType: 'saved_scan', sourceId: A }, label: 'Go', extraField: 'x' },
      { type: 'delete_account' },
      { type: 'style_anchor_item', anchor: { sourceType: 'saved_scan', sourceId: FOREIGN } },
      { type: 'style_anchor_item', anchor: { sourceType: 'saved_scan', sourceId: '<ref id>' } },
      { type: 'open_look', lookId: FOREIGN },
      { type: 'open_look', lookId: LOOK },
    ])}</actions>`,
  );
  assert.equal(extracted.text, 'Happy to help.');
  const validated = actions.validateStyleChatActions(extracted.rawActions, resolvedFixture);
  assert.equal(validated.length, 2);
  assert.equal(validated[0].type, 'style_anchor_item');
  assert.equal(validated[0].payload.anchor.sourceId, A);
  assert.ok(!('extraField' in validated[0]) && !('extraField' in validated[0].payload));
  assert.equal(validated[1].type, 'open_look');
  assert.equal(validated[1].payload.lookId, LOOK);
});

test('malformed actions block leaves reply intact; no arbitrary routes/RPC/mutations', () => {
  const broken = actions.extractActionsBlock('Reply text. <actions>{not json]</actions>');
  assert.equal(broken.text, 'Reply text.');
  assert.equal(actions.validateStyleChatActions(broken.rawActions, resolvedFixture).length, 0);
  const cards = fs.readFileSync(path.join(ROOT, 'components', 'style-chat', 'StyleChatActionCards.tsx'), 'utf8');
  assert.match(cards, /APP_LABELS/);
  assert.doesNotMatch(cards, /JSON\.stringify\(action/);
  assert.match(cards, /default:\s*\n?\s*return null/);
  // No mutation services invoked from action execution.
  assert.doesNotMatch(cards, /createLook|shareLooks|castOutfit|supabase\./);
});

// ── Remote media ──────────────────────────────────────────────────────────────

test('media migration is additive, private-bucket only, ready-requires-path', () => {
  assert.match(mediaMigration, /add column if not exists storage_bucket/);
  assert.match(mediaMigration, /media_status in \('pending', 'ready', 'failed'\)/);
  assert.match(mediaMigration, /saved_scans_media_ready_requires_path/);
  assert.doesNotMatch(mediaMigration, /drop column|create bucket|public = true/i);
  // Inspiration styling metadata (eligibility basis) is additive too.
  assert.match(mediaMigration, /alter table public\.inspiration_items/);
  assert.match(mediaMigration, /garment_role/);
});

test('audit migration enforces media path authority and immutable inspiration media fields', () => {
  assert.match(auditMigration, /saved_scans_media_path_owner_contract/);
  assert.match(auditMigration, /user_id::text \|\| '\/saved-scans\/' \|\| id::text \|\| '[.]jpg'/);
  assert.match(auditMigration, /inspiration_items_media_path_owner_contract/);
  assert.match(auditMigration, /\/inspirations\/\[A-Za-z0-9\._-\]\+\[.\]jpg/);
  assert.match(auditMigration, /prevent_inspiration_item_media_rewrite/);
  assert.match(auditMigration, /new\.storage_path is distinct from old\.storage_path/);
  assert.match(auditMigration, /old\.deleted_at is not null and new\.deleted_at is null/);
});

test('final role privilege migration removes unsafe grants and gates quota lifecycle', () => {
  assert.match(rolePrivilegeMigration, /revoke truncate, references, trigger, maintain on all tables in schema public/);
  assert.match(rolePrivilegeMigration, /revoke all privileges on all sequences in schema public/);
  assert.match(rolePrivilegeMigration, /grant select, insert, update, delete on all tables in schema public\s+to service_role/);
  assert.match(rolePrivilegeMigration, /account_status in \('pending_deletion', 'locked'\)/);
  assert.match(rolePrivilegeMigration, /increment_stylechat_daily_usage/);
  assert.match(rolePrivilegeMigration, /check_and_increment_stylechat_burst/);
  assert.match(rolePrivilegeMigration, /increment_style_outfit_daily_usage/);
  assert.match(rolePrivilegeMigration, /check_and_increment_style_outfit_burst/);
});

test('media saga: deterministic path, no duplicate upload, finalize-first retry, exact-path orphan cleanup', () => {
  assert.match(mediaService, /buildSavedScanMediaPath/);
  assert.match(mediaService, /\$\{userId\}\/saved-scans\/\$\{savedScanId\}\.jpg/);
  assert.doesNotMatch(mediaService, /row\.storage_path[\s\S]{0,80}\?[\s\S]{0,80}row\.storage_path/);
  assert.match(mediaService, /row\.storage_path === path/);
  assert.match(mediaService, /await verifyObjectExists\(bucket, path\)/);
  assert.match(mediaService, /upsert: false/);
  assert.match(mediaService, /isAlreadyExistsError/);
  assert.match(mediaService, /verifyObjectExists\(bucket, path\)\) \{\s*\n?\s*return finalizeMediaRow/);
  assert.match(mediaService, /input\.path !== buildSavedScanMediaPath\(userId, input\.savedScanId\)\) return false/);
  assert.doesNotMatch(mediaService, /getPublicUrl/);
  // Local file preserved: the saga never deletes local files.
  assert.doesNotMatch(mediaService, /deleteAsync/);
});

test('account deletion covers the saved-scans media prefix; no bulk historical upload exists', () => {
  assert.match(deletionScript, /\$\{userId\}\/saved-scans/);
  const owned = fs.readFileSync(path.join(ROOT, 'services', 'ownedClosetItems.ts'), 'utf8');
  assert.doesNotMatch(owned, /ensureSavedScanMediaBacking/); // listing never triggers uploads
  assert.match(mediaService, /Lazy: call only for explicit/);
});

// ── Inspiration eligibility (style-outfit-generate) ──────────────────────────

test('inspiration eligibility gate: category, attributes, role, image all required', () => {
  const reasoning = loadTsModule('supabase/functions/style-outfit-generate/reasoningContract.ts');
  const validation = loadTsModule('supabase/functions/style-outfit-generate/validation.ts', {
    './reasoningContract.ts': reasoning,
  });
  const base = {
    id: A,
    user_id: USER,
    deleted_at: null,
    storage_bucket: 'style-library-images',
    storage_path: `${USER}/inspirations/ref.jpg`,
    category: 'Blazer', color: 'Navy', note: 'ref',
  };
  assert.equal(validation.buildCandidatesFromInspirationItems([base]).length, 1);
  assert.equal(validation.buildCandidatesFromInspirationItems([
    { ...base, storage_path: `${FOREIGN}/inspirations/ref.jpg` },
  ]).length, 0);
  assert.equal(validation.buildCandidatesFromInspirationItems([{ ...base, category: 'unknown' }]).length, 0);
  assert.equal(validation.buildCandidatesFromInspirationItems([{ ...base, category: null }]).length, 0);
  assert.equal(validation.buildCandidatesFromInspirationItems([{ ...base, color: null }]).length, 0);
  assert.equal(validation.buildCandidatesFromInspirationItems([{ ...base, storage_path: null }]).length, 0);
  // Role 'other' without override excluded; explicit override accepted.
  const vague = { ...base, category: 'Mystery piece', color: 'Red' };
  assert.equal(validation.buildCandidatesFromInspirationItems([vague]).length, 0);
  assert.equal(validation.buildCandidatesFromInspirationItems([{ ...vague, garment_role: 'top' }]).length, 1);
});
