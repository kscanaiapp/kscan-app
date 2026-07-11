// V1/V2 StyleChat compatibility tests after Elise identity changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const edgeIndex = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'index.ts'), 'utf8');
const edgeAttachments = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'attachments.ts'), 'utf8');
const edgeActions = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'actions.ts'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'services', 'style-chat', 'providers', 'edgeStyleChatProvider.ts'), 'utf8');
const types = fs.readFileSync(path.join(ROOT, 'types', 'styleChatAttachments.ts'), 'utf8');

// ── v1 request shape ─────────────────────────────────────────────────────────

test('v1 request shape remains accepted: sessionId and message only', () => {
  assert.match(edgeIndex, /const sessionId = typeof body\.sessionId === 'string'/);
  assert.match(edgeIndex, /const message   = typeof body\.message   === 'string'/);
  assert.match(edgeIndex, /if \(!sessionId\) return json\(\{ error: 'sessionId required' \}, 400\)/);
  assert.match(edgeIndex, /if \(!message\)   return json\(\{ error: 'message required' \}, 400\)/);
});

test('v1 optional additive fields remain optional', () => {
  assert.match(edgeIndex, /styleDnaContext/);
  assert.match(edgeIndex, /activeContext/);
  assert.match(edgeIndex, /weatherLocation/);
});

// ── v2 request shape ─────────────────────────────────────────────────────────

test('v2 is triggered only by attachments array or contractVersion 2', () => {
  assert.match(edgeAttachments, /contractVersion === STYLECHAT_ATTACHMENT_CONTRACT_VERSION/);
  assert.match(edgeAttachments, /Array\.isArray\(body\.attachments\) && body\.attachments\.length > 0/);
});

test('v2 attachment contract version remains 2', () => {
  assert.match(types, /STYLECHAT_ATTACHMENT_CONTRACT_VERSION = '2'/);
  assert.match(provider, /STYLECHAT_ATTACHMENT_CONTRACT_VERSION/);
});

// ── Response compatibility ───────────────────────────────────────────────────

test('v1 response schema remains compatible', () => {
  assert.match(edgeIndex, /status:\s*usedFallback \? 'error' : 'success'/);
  assert.match(edgeIndex, /message:\s*responseMessage/);
  assert.match(edgeIndex, /usage:\s*\{ messagesUsed, messagesLimit, resetAt \}/);
});

test('v2 response includes additive fields only', () => {
  assert.match(edgeIndex, /contractVersion:\s*STYLECHAT_ATTACHMENT_CONTRACT_VERSION/);
  assert.match(edgeIndex, /capabilities:/);
  assert.match(edgeIndex, /actions:/);
  assert.match(edgeIndex, /attachmentsResolved/);
  assert.match(edgeIndex, /imagesInspected/);
});

// ── Action parsing compatibility ─────────────────────────────────────────────

test('allowed action types are unchanged', () => {
  const expected = ['open_stylist', 'style_anchor_item', 'style_for_event', 'restyle_outfit', 'swap_item', 'open_look', 'ask_my_room'];
  for (const action of expected) {
    assert.match(edgeActions, new RegExp(`'${action}'`));
  }
});

test('action labels are normalized against app-controlled defaults', () => {
  assert.match(edgeActions, /boundLabel\(record\.label, actionType\)/);
  assert.match(edgeActions, /DEFAULT_LABELS\[type\]/);
});

// ── Quota and authorization paths ────────────────────────────────────────────

test('quota and burst RPC names remain stable', () => {
  assert.match(edgeIndex, /increment_stylechat_daily_usage/);
  assert.match(edgeIndex, /check_and_increment_stylechat_burst/);
});

test('authorization remains JWT-derived through user client', () => {
  assert.match(edgeIndex, /authHeader/);
  assert.match(edgeIndex, /userClient\.auth\.getUser/);
});
