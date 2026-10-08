'use strict';

/**
 * Build 34 -> 1.1.0 final product polish pass.
 *
 * One test (or group) per POLISH-### repair in
 * docs/audits/BUILD34_FINAL_POLISH_PASS.md. Behavioural repairs are exercised
 * for real -- the component or helper is transpiled and executed -- and carry a
 * negative control that re-runs the same assertion against a mutated source and
 * requires it to FAIL, so a test that stops biting is caught. Copy and
 * accessibility-metadata repairs are pinned with focused source assertions,
 * the convention this suite's neighbours use for TSX screens.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function transpile(source, rel) {
  return ts.transpileModule(source, {
    fileName: rel,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
}

/** Any property is itself, calling it returns itself: a stand-in for theme tokens. */
function deepStub() {
  const target = function stub() {};
  const proxy = new Proxy(target, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => 0 : prop === '__esModule' ? false : proxy),
    apply: () => proxy,
  });
  return proxy;
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  memo: (component) => component,
};

function load(rel, { platformOS = 'ios', modules = {}, mutate = (s) => s } = {}) {
  const source = mutate(read(rel));
  const reactNative = {
    Platform: { OS: platformOS },
    StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
    AccessibilityInfo: { announceForAccessibility: () => {} },
  };
  for (const name of ['ActivityIndicator', 'Image', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'TouchableOpacity', 'View']) {
    reactNative[name] = name;
  }
  const shim = (spec) => {
    if (spec === 'react') return { __esModule: true, default: React, ...React };
    if (spec === 'react-native') return reactNative;
    if (spec in modules) return modules[spec];
    return deepStub();
  };
  const mod = { exports: {} };
  // `React` is passed in for files written against the automatic JSX runtime
  // (no React import); a file that imports React shadows it with its own binding.
  vm.runInThisContext(`(function (exports, module, require, React) {\n${transpile(source, rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, shim, React);
  return mod.exports;
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.props && node.props.children, predicate, out);
  return out;
}

function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
}

/** The assertion must fail AS AN ASSERTION -- a harness crash is not a bite. */
function assertFails(fn, why) {
  let failure = null;
  try {
    fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `negative control did not bite: ${why}`);
  assert.equal(failure.code, 'ERR_ASSERTION', `negative control crashed instead of failing: ${failure.message}`);
}

/** User-visible string content of a TSX file: literals and JSX text, never comments. */
function visibleStrings(rel) {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    // Test identifiers are not copy.
    if (ts.isJsxAttribute(node) && /^(testID|nativeID|key)$/.test(node.name.getText(sf))) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isJsxText(node)) out.push(node.getText(sf));
    else if (ts.isTemplateExpression(node)) out.push(node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ── POLISH-001 / 003 / 007: the shared K+ Early Access sheet ────────────────

const SHEET = 'components/kplus/KPlusEarlyAccessSheet.tsx';

test('POLISH-029: the shared K+ sheet uses the central activation-offer copy authority', () => {
  const source = read(SHEET);
  assert.match(
    source,
    /KPLUS_ACTIVATION_OFFER_TERM/,
    'the sheet must consume the shared campaign-copy authority',
  );
  assert.doesNotMatch(
    visibleStrings(SHEET).join('\n'),
    /\b6 months\b/i,
    'the shared sheet must not hardcode an offer duration independently',
  );
});

function renderSheet(state, { mutate, refresh = () => {} } = {}) {
  const entitlements = load('types/entitlements.ts');
  const { KPlusEarlyAccessSheet } = load(SHEET, {
    mutate,
    modules: {
      '../luxury': { InlineNotice: 'InlineNotice', PrimaryButton: 'PrimaryButton', SecondaryButton: 'SecondaryButton' },
      '../../hooks/useKPlusEntitlement': {
        useKPlusEntitlement: () => ({
          state,
          expiresAt: state === 'active' ? '2099-01-01T00:00:00.000Z' : null,
          activate: async () => 'granted',
          refresh,
        }),
      },
      '../../hooks/useKPlusLiveCapabilitySignals': {
        useKPlusLiveCapabilitySignals: () => ({ signals: {}, settled: true }),
      },
      '../../services/kplus/kplusActivationCatalog': {
        resolveActivationCapabilities: () => [{ id: 'voice_scan', title: 'Voice Scan' }],
        // FC-02: the list is passed through the promotion filter. Nothing is
        // dimmed in this harness, so it is the identity.
        selectPromotedCapabilities: (capabilities) => capabilities,
      },
      '../../services/kplus/kplusTelemetry': { emitKPlusEvent: () => {} },
      '../../types/entitlements': entitlements,
    },
  });
  return KPlusEarlyAccessSheet({ visible: true, onClose: () => {}, source: 'onboarding' });
}

const buttons = (tree, type) => findAll(tree, (n) => n.type === type);
const buttonTitled = (tree, title) =>
  findAll(tree, (n) => (n.type === 'PrimaryButton' || n.type === 'SecondaryButton') && n.props.title === title);

function assertUnresolvedShowsNoOffer(tree, label) {
  assert.equal(buttonTitled(tree, 'Activate K+ Early Access').length, 0, `${label}: no Activate CTA`);
  assert.ok(!textOf(tree).includes('More ways to use K Scan AI.'), `${label}: no offer copy`);
  assert.ok(!textOf(tree).includes('complimentary for 6 months'), `${label}: no offer terms`);
}

test('POLISH-001: a loading entitlement shows a checking state, never the offer', () => {
  const tree = renderSheet('loading');
  assertUnresolvedShowsNoOffer(tree, 'loading');
  assert.ok(textOf(tree).includes('Checking your K+ access'));
  assert.equal(buttonTitled(tree, 'Try Again').length, 0, 'nothing to retry while the first read is outstanding');
  assert.equal(buttonTitled(tree, 'Not Now').length, 1, 'the sheet can always be dismissed');
});

test('POLISH-001: an unreadable entitlement says so and offers a retry wired to refresh', () => {
  const refresh = () => {};
  const tree = renderSheet('error', { refresh });
  assertUnresolvedShowsNoOffer(tree, 'error');
  assert.ok(textOf(tree).includes('We could not check your K+ access'));
  const retry = buttonTitled(tree, 'Try Again');
  assert.equal(retry.length, 1);
  assert.equal(retry[0].props.onPress, refresh, 'Try Again re-reads the entitlement');
  assert.equal(buttonTitled(tree, 'Not Now').length, 1);
});

test('POLISH-001 CONTROL: an eligible actor still gets the offer (the harness renders it)', () => {
  const tree = renderSheet('eligible');
  assert.equal(buttonTitled(tree, 'Activate K+ Early Access').length, 1);
  assert.ok(textOf(tree).includes('More ways to use K Scan AI.'));
});

test('POLISH-001 NEGATIVE CONTROL: without the resolving branch the error state pitches the offer again', () => {
  const mutate = (s) => s
    .replace(
      'const resolving = isKPlusEntitlementUnresolved(state);',
      'const resolving = false;',
    )
    .replace(
      "KPLUS_EARLY_ACCESS_ENABLED && state === 'eligible';",
      'true;',
    );
  assert.notEqual(mutate(read(SHEET)), read(SHEET), 'the mutation must apply');
  assertFails(() => assertUnresolvedShowsNoOffer(renderSheet('error', { mutate }), 'error'), 'error renders offer');
  assertFails(() => assertUnresolvedShowsNoOffer(renderSheet('loading', { mutate }), 'loading'), 'loading renders offer');
});

test('POLISH-003: the activated sheet says what changed', () => {
  const tree = renderSheet('active');
  assert.ok(textOf(tree).includes('K+ features are now unlocked on this account.'));
  assert.equal(buttonTitled(tree, 'Activate K+ Early Access').length, 0);
});

test('POLISH-007: the Done button is announced as "Done", not "Close"', () => {
  for (const state of ['active', 'expired']) {
    const done = buttonTitled(renderSheet(state), 'Done');
    assert.equal(done.length, 1, state);
    assert.equal(done[0].props.accessibilityLabel, undefined, `${state}: the visible title is the name`);
  }
});

// ── POLISH-002 / 008: the Account screen's K+ row ────────────────────────────

const ACCOUNT_STATUS = 'services/kplus/kplusAccountStatus.ts';
const OFFER_COPY = 'Complimentary for 6 months. No payment required.';

function accountStatus(mutate, complimentaryAcquisitionEnabled = true) {
  const describe = load(ACCOUNT_STATUS, { mutate }).describeKPlusAccountStatus;
  return (state, expiryLabel) => describe(state, expiryLabel, complimentaryAcquisitionEnabled);
}

function assertResolvingIsNotFree(describe) {
  for (const state of ['loading', 'error']) {
    const status = describe(state, null);
    assert.notEqual(status.subtitle, OFFER_COPY, `${state} must not show the offer`);
    assert.notEqual(status.action, 'activate', `${state} must not offer activation`);
    assert.equal(status.pillLabel, null, `${state} states no membership`);
  }
  assert.equal(describe('error', null).action, 'retry', 'an unreadable status can be re-checked');
  assert.equal(describe('loading', null).action, null);
}

test('POLISH-002: loading and error never read as the free-tier offer', () => {
  assertResolvingIsNotFree(accountStatus());
});

test('POLISH-002: the resolved states keep their existing presentation', () => {
  const describe = accountStatus();
  assert.deepEqual(
    { ...describe('eligible', null) },
    { subtitle: OFFER_COPY, pillLabel: 'Early Access available', pillVariant: 'neutral', action: 'activate' },
  );
  const active = describe('active', 'March 1, 2027');
  assert.equal(active.subtitle, 'Active through March 1, 2027.');
  assert.equal(active.pillLabel, 'K+ Active');
  assert.equal(active.pillVariant, 'gold');
  assert.equal(active.action, null);
});

test('Build 35: acquisition OFF keeps the resolved Free account state but removes complimentary offer copy', () => {
  const eligible = accountStatus(undefined, false)('eligible', null);
  assert.equal(eligible.subtitle, 'K+ is not active on this account.');
  assert.equal(eligible.pillLabel, 'K Scan AI Free');
  assert.equal(eligible.action, null);
});

test('POLISH-002 NEGATIVE CONTROL: the pre-repair fallthrough (offer for every unknown state) is caught', () => {
  const mutate = (s) => s
    .replace("case 'loading':", "case '__loading_removed__':")
    .replace("case 'error':", "case '__error_removed__':")
    .replace("case 'unavailable':\n    default:\n      return {\n        subtitle: 'K+ status is not available right now.'",
      "case 'unavailable':\n    default:\n      return {\n        subtitle: 'Complimentary for 6 months. No payment required.'");
  assert.notEqual(mutate(read(ACCOUNT_STATUS)), read(ACCOUNT_STATUS));
  assertFails(() => assertResolvingIsNotFree(accountStatus(mutate)), 'offer shown while resolving');
});

test('POLISH-008: the expired subtitle adds information instead of repeating the pill', () => {
  const expired = accountStatus()('expired', null);
  assert.equal(expired.pillLabel, 'Complimentary access ended');
  assert.notEqual(expired.subtitle.replace(/\.$/, ''), expired.pillLabel);
  assert.match(expired.subtitle, /no charge and nothing to cancel/);
});

test('POLISH-002: the Account screen renders the helper and wires retry to refresh', () => {
  const privacy = read('app/privacy.tsx');
  assert.match(privacy, /describeKPlusAccountStatus\([\s\S]*kPlusEntitlement\.state,[\s\S]*KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(privacy, /kPlusStatus\.action === 'retry'\s*\?\s*kPlusEntitlement\.refresh/);
  assert.ok(!privacy.includes(OFFER_COPY), 'the offer copy lives in one place, the helper');
});

// ── POLISH-005: complimentary K+ is unlocked, not upgraded to ────────────────

test('POLISH-005: no K+ surface tells a user to "upgrade" to complimentary K+', () => {
  const files = [
    'components/text-scan/TextScanFeatureRow.tsx',
    'components/text-scan/VoiceScanButton.tsx',
    'components/text-scan/VoiceListeningSheet.tsx',
    'components/home/HomeVoiceScanPill.tsx',
    'components/account-home/PermissionsStepV1.tsx',
    'components/kplus/KPlusEarlyAccessSheet.tsx',
    'components/kplus/KPlusActivationStep.tsx',
    'components/vto/TryItOnEntry.tsx',
    'app/packing/index.tsx',
  ];
  for (const rel of files) {
    for (const s of visibleStrings(rel)) {
      assert.doesNotMatch(s, /\bupgrade\b/i, `${rel} says "${s}"`);
    }
  }
  assert.match(read('components/text-scan/VoiceScanButton.tsx'), /'UNLOCK WITH K\+'/);
  assert.match(read('components/text-scan/VoiceListeningSheet.tsx'), /body: 'Unlock K\+ to use Voice Scan\. You can still search by typing below\.'/);
});

// ── POLISH-006: Watch entry points say when a tap opens K+ ───────────────────

test('POLISH-006: Watchlist entries explain K+ and the intent-first acquisition step', () => {
  for (const rel of [
    'components/ProductShelf.tsx',
    'components/scan-results/PurchaseOptionsPanel.tsx',
    'components/home/HomeLuxuryTechV1.tsx',
  ]) {
    const src = read(rel);
    if (rel.includes('HomeLuxuryTechV1')) {
      assert.match(src, /'Available with K\+\. Opens K\+ membership options\.'/);
    } else {
      assert.match(src, /["']Track this product and price changes with K\+["']/);
    }
  }
  for (const rel of ['components/ProductShelf.tsx', 'components/scan-results/PurchaseOptionsPanel.tsx']) {
    assert.match(read(rel), /Watch\s*\n\s*\{!isActive && !resolving \? ' · K\+' : null\}/, `${rel} marks the locked Watch visibly`);
  }
});

// ── POLISH-009: a scan is saved to Recent Scans, not the (owned) Closet ──────

test('POLISH-009: the scan-save confirmation names where the scan went and is announced', () => {
  const app = read('app.js');
  const toast = app.slice(app.indexOf('function SavedToast'), app.indexOf('function ActionButton'));
  assert.match(toast, /CLOSET_SEPARATION_V1 \? 'Saved to Recent Scans' : 'Saved to Style Closet'/);
  assert.match(toast, /announceForAccessibility\?\.\(message\);\s*\n[^\n]*\n\s*\}, \[\]\);/, 'announced once, on mount');
  assert.match(app, /import \{\s*CLOSET_SEPARATION_V1,[\s\S]*?\} from '\.\/constants\/featureFlags';/);
  assert.match(read('app/library.tsx'), /CLOSET_SEPARATION_V1\s*\?\s*'This will remove the scan from your Recent Scans\.'/);
  assert.ok(!read('components/scan-results/PurchaseOptionsPanel.tsx').includes('save this look to your Closet'));
});

// ── POLISH-012: a Text Scan failure keeps the query ──────────────────────────

test('POLISH-012: after a Text Scan failure, Edit Search returns to the input without clearing it', () => {
  const src = read('app/text-scan/index.tsx');
  const at = src.indexOf('testID="textscan-edit-after-error"');
  assert.ok(at > 0);
  const block = src.slice(src.lastIndexOf('{textScanError ? (', at), at);
  assert.match(block, /onPress=\{\(\) => setViewState\('input'\)\}/);
  assert.doesNotMatch(block, /handleScanAgain|setQuery/);
});

// ── POLISH-013: Signature Style details are reachable with VoiceOver ─────────

const SIGNATURE = 'components/style-chat/StyleChatSignatureStyleCard.tsx';

function sheetWrappers(platformOS, mutate) {
  const mod = load(SIGNATURE, { platformOS, mutate });
  const Card = mod.StyleChatSignatureStyleCard || mod.default;
  const tree = Card({ summary: null, loading: false, resetting: false, learnFromFeedback: true, onReset: () => {} });
  const isDone = (n) => n.type === 'Pressable' && n.props.accessibilityLabel === 'Close Signature Style details';
  // Every Pressable that contains the sheet's Done button wraps the sheet.
  return findAll(tree, (n) => n.type === 'Pressable' && !isDone(n) && findAll(n.props.children, isDone).length > 0);
}

function assertIosSheetReachable(wrappers) {
  assert.equal(wrappers.length, 2, 'backdrop and sheet');
  for (const w of wrappers) assert.equal(w.props.accessible, false);
}

test('POLISH-013: on iOS neither sheet wrapper hides Reset or Done from VoiceOver', () => {
  assertIosSheetReachable(sheetWrappers('ios'));
});

test('POLISH-013: Android is unchanged (TalkBack reaches nested buttons)', () => {
  for (const w of sheetWrappers('android')) assert.equal(w.props.accessible, undefined);
});

test('POLISH-013 NEGATIVE CONTROL: without the repair the iOS wrappers are accessible elements again', () => {
  const mutate = (s) => s.split("accessible={Platform.OS === 'ios' ? false : undefined}").join('');
  assert.notEqual(mutate(read(SIGNATURE)), read(SIGNATURE));
  assertFails(() => assertIosSheetReachable(sheetWrappers('ios', mutate)), 'wrappers accessible');
});

// ── POLISH-014: auth buttons are named buttons, including while busy ────────

test('POLISH-014: auth primary actions carry a button role; busy ones keep their name', () => {
  for (const [rel, label, testID] of [
    ['app/auth/reset.tsx', 'Send reset link', 'auth-reset-submit'],
    ['app/auth/update-password.tsx', 'Update password', 'auth-update-password-submit'],
  ]) {
    const src = read(rel);
    const at = src.indexOf(`testID="${testID}"`);
    assert.ok(at > 0, `${rel} submit control`);
    const tag = src.slice(src.lastIndexOf('<Pressable', at), src.indexOf('\n          >', at) + 12);
    assert.match(tag, /accessibilityRole="button"/, rel);
    assert.match(tag, new RegExp(`accessibilityLabel="${label}"`), rel);
    assert.match(tag, /accessibilityState=\{\{ disabled: busy, busy \}\}/, rel);
  }
  assert.match(read('app/auth/callback.tsx'), /onPress=\{openAuth\} accessibilityRole="button"/);
  assert.match(read('app/auth/index.tsx'), /onPress=\{handleBackToSignIn\} accessibilityRole="button"/);
});

// ── POLISH-015: product name ─────────────────────────────────────────────────

test('POLISH-015: the AI report sheet names the product "K Scan AI"', () => {
  const src = read('contexts/AiOutputReportingContext.tsx');
  assert.match(src, /Thank you for helping keep K Scan AI safe\./);
  assert.match(src, /Your report is sent to K Scan AI for review\./);
  assert.doesNotMatch(src, /K Scan (?!AI)[a-z]/);
});

// ── POLISH-016: Voice Scan touch target ──────────────────────────────────────

test('POLISH-016: the 40pt Voice Scan pill has a 48pt touch area', () => {
  const src = read('components/text-scan/VoiceScanButton.tsx');
  assert.match(src, /height: 40,/);
  assert.match(src, /hitSlop=\{\{ top: 4, bottom: 4, left: 0, right: 0 \}\}/);
});
