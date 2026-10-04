// K+ "Redeem an offer" -- the customer-facing redemption surface (Build 35
// VTO design-polish addendum).
//
// This suite proves the presentation and interaction CONTRACT of
// components/kplus/KPlusRedeemOfferPanel.tsx, executed for real through the
// shared component renderer over the REAL pure model
// (services/kplus/kplusOfferRedemption.ts):
//
//   - the entry point and the swap into the surface are proven at the step
//     level in __tests__/kplusPaywallPhaseD.test.js ("promo: Redeem an offer
//     opens the real in-step redemption surface");
//   - Monthly / Lifetime / Restore / Free behaviour is proven unchanged by the
//     rest of that same suite, which renders the paywall with the seam live.
//
// What this surface must NEVER do is also proven here: no hardcoded valid
// codes, no client-side allowlist, no entitlement mutation, and no
// RevenueCat / Supabase / network call inside the presentational layer. The
// offer-code ingestion authority belongs to the later integration audit and
// arrives through the redeemOfferCode port.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  deferred,
  findAll,
  runModule,
  settle,
  textContent,
} = require('./helpers/componentRenderer');

const PANEL = 'components/kplus/KPlusRedeemOfferPanel.tsx';
const REDEMPTION = 'services/kplus/kplusOfferRedemption.ts';
const PARTS = 'components/kplus/KPlusPaywallParts.tsx';
const MODEL = 'services/kplus/kplusPaywallModel.ts';
const THEME = 'constants/kplusPaywallTheme.ts';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');

const themeTokens = {
  LUXURY: deepStub(),
  SPACING: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  RADIUS: { sm: 12, md: 16, lg: 24, xl: 28, pill: 999 },
};

/**
 * Renders the REAL panel + REAL parts + REAL redemption model. The only
 * stubbed edges are React Native itself, the icon registry (presentational),
 * and the port the caller supplies.
 */
function mountPanel(o = {}) {
  const renderer = createRenderer();
  const announcements = [];
  const rn = createReactNativeStub({ announcements });
  const calls = { portCalls: [], closes: 0 };

  const theme = runModule(THEME, {}, { jsx: false });
  const paywallModel = runModule(MODEL, {}, { jsx: false });
  const redemption = runModule(REDEMPTION, {}, { jsx: false });
  const parts = runModule(PARTS, {
    ...renderer.runtimeModules,
    'react-native': rn,
    '../../constants/theme': themeTokens,
    '../../constants/kplusPaywallTheme': theme,
    '../../services/kplus/kplusPaywallModel': paywallModel,
    '../icons/kscan': { KScanIcon: 'KScanIcon' },
  });
  const panel = runModule(PANEL, {
    ...renderer.runtimeModules,
    'react-native': rn,
    '../../constants/theme': themeTokens,
    '../../constants/kplusPaywallTheme': theme,
    '../../services/kplus/kplusOfferRedemption': redemption,
    '../../services/kplus/kplusOfferRedemptionClient': {
      redeemKPlusOfferCode: async () => 'UNAVAILABLE',
    },
    './KPlusPaywallParts': parts,
  });

  const port = o.port ?? null;
  const props = {
    ...(port ? { redeemOfferCode: async (code) => { calls.portCalls.push(code); return port(code); } } : {}),
    onClose: () => { calls.closes += 1; },
  };

  let tree = null;
  let typed = '';
  const api = {
    calls,
    announcements,
    render() {
      tree = renderer.render(renderer.jsx(panel.KPlusRedeemOfferPanel, props));
      return tree;
    },
    get tree() { return tree; },
    text() { return textContent(tree); },
    has(testID) { return byTestId(tree, testID).length > 0; },
    node(testID) {
      const found = byTestId(tree, testID).filter((n) => typeof n.type === 'string');
      assert.ok(found.length > 0, `no host element with testID ${testID}`);
      return found[0];
    },
    async type(text) {
      for (const ch of text.split('')) {
        typed += ch;
        api.node('kplus-redeem-offer-input').props.onChangeText(typed);
        await settle();
        api.render();
      }
      return api.render();
    },
    async submit() {
      api.node('kplus-redeem-offer-submit').props.onPress();
      await settle();
      return api.render();
    },
  };
  api.render();
  return api;
}

// ── Structure and accessibility of the entry state ───────────────────────────

test('redeem surface: title, explanation, labelled input, Redeem and Cancel', () => {
  const ui = mountPanel();
  assert.ok(ui.has('kplus-redeem-offer-panel'));
  assert.match(ui.text(), /Redeem an offer/);
  assert.match(ui.text(), /Enter your K Scan AI offer code\./);

  const input = ui.node('kplus-redeem-offer-input');
  assert.equal(input.props.accessibilityLabel, 'Offer code');
  assert.ok(input.props.accessibilityHint.length > 0, 'the input carries a hint');
  assert.equal(input.props.autoCorrect, false, 'codes are never autocorrected');
  assert.equal(input.props.autoCapitalize, 'characters');
  const inputStyle = Object.assign({}, ...[].concat(input.props.style).filter(Boolean));
  assert.ok(inputStyle.minHeight >= 44, 'input meets the minimum touch height');

  assert.ok(ui.has('kplus-redeem-offer-submit'));
  assert.ok(ui.has('kplus-redeem-offer-cancel'));
  const header = findAll(ui.tree, (n) => n.props?.accessibilityRole === 'header');
  assert.ok(header.length > 0, 'the title is a header for screen readers');

  // Customer-facing wording never exposes implementation vocabulary.
  assert.doesNotMatch(
    ui.text(),
    /entitlement grant|revenuecat|supabase|provider|promotional grant|RPC|store package/i,
    'no implementation terminology on the surface',
  );
});

// ── 2. Empty code cannot submit ──────────────────────────────────────────────

test('empty code: the Redeem action is disabled and the port is never called', async () => {
  const port = async () => 'SUCCESS';
  const ui = mountPanel({ port });

  const submit = ui.node('kplus-redeem-offer-submit');
  assert.equal(submit.props.accessibilityState.disabled, true, 'empty code disables Redeem');

  await ui.submit();
  assert.equal(ui.calls.portCalls.length, 0, 'the port is not called for an empty code');
  assert.ok(!ui.has('kplus-redeem-offer-validating'), 'no validating state without a submission');

  // Whitespace-only is still empty after harmless normalization.
  await ui.type('   ');
  await ui.submit();
  assert.equal(ui.calls.portCalls.length, 0, 'surrounding whitespace does not make a code');
});

// ── 3. Submission calls only the supplied port ───────────────────────────────

test('submission: the normalized code goes to the supplied port, and nowhere else', async () => {
  const port = async () => 'INVALID';
  const ui = mountPanel({ port });

  await ui.type('  WELCOME-2026  ');
  await ui.submit();
  await settle();
  ui.render();

  assert.deepEqual(ui.calls.portCalls, ['WELCOME-2026'], 'surrounding whitespace is trimmed, code verbatim');
  // No port supplied at all: the surface still answers, honestly UNAVAILABLE.
  const noPort = mountPanel();
  await noPort.type('ANY-CODE');
  await noPort.submit();
  await settle();
  noPort.render();
  assert.ok(noPort.has('kplus-redeem-offer-error'));
  assert.match(noPort.text(), /cannot be redeemed right now/);
});

// ── 7. Loading prevents duplicate submissions ────────────────────────────────

test('validating: a second tap cannot duplicate the submission', async () => {
  const gate = deferred();
  const port = () => gate.promise;
  const ui = mountPanel({ port });

  await ui.type('WELCOME-2026');
  // Submit without flushing the port: the attempt is in flight.
  ui.node('kplus-redeem-offer-submit').props.onPress();
  await settle();
  ui.render();

  assert.ok(ui.has('kplus-redeem-offer-validating'), 'the validating state renders');
  const submit = ui.node('kplus-redeem-offer-submit');
  assert.equal(submit.props.accessibilityState.disabled, true, 'Redeem is disabled while validating');
  assert.equal(submit.props.accessibilityState.busy, true, 'and announced busy');

  // A second tap while in flight is refused by both the control and the reducer.
  submit.props.onPress();
  await settle();
  assert.equal(ui.calls.portCalls.length, 1, 'still exactly one port call');

  // The input is not editable mid-flight.
  assert.equal(ui.node('kplus-redeem-offer-input').props.editable, false);

  gate.resolve('SUCCESS');
  await settle();
  ui.render();
  assert.ok(ui.has('kplus-redeem-offer-success'), 'the resolution lands after the gate opens');
});

// ── 8. Bounded error states ──────────────────────────────────────────────────

test('every non-success verdict renders its own bounded failure state', async () => {
  const cases = [
    ['INVALID', /Code not recognized/, /Check the code and try again\./],
    ['EXPIRED', /Offer expired/, /no longer active/],
    ['ALREADY_USED', /Code already used/, /already been redeemed/],
    ['NOT_ELIGIBLE', /Offer not available/, /not available for your account/],
    ['UNAVAILABLE', /Offers unavailable/, /cannot be redeemed right now/],
    ['ERROR', /Something went wrong/, /could not be checked/],
  ];
  for (const [verdict, title, body] of cases) {
    const ui = mountPanel({ port: async () => verdict });
    await ui.type('SOME-CODE');
    await ui.submit();
    await settle();
    ui.render();
    assert.ok(ui.has('kplus-redeem-offer-error'), `${verdict} renders the failure block`);
    assert.match(ui.text(), title, `${verdict} title`);
    assert.match(ui.text(), body, `${verdict} body`);
    assert.equal(
      ui.node('kplus-redeem-offer-error').props.accessibilityLiveRegion,
      'polite',
      `${verdict} is announced politely`,
    );
    // Editing after a failure returns to a clean entry state.
    await ui.type('-2');
    assert.ok(!ui.has('kplus-redeem-offer-error'), `${verdict} clears when the code is edited`);
  }

  // A misbehaving port (unknown verdict or a throw) degrades to ERROR.
  const junk = mountPanel({ port: async () => 'TOTALLY_UNKNOWN' });
  await junk.type('SOME-CODE');
  await junk.submit();
  await settle();
  junk.render();
  assert.match(junk.text(), /Something went wrong/, 'an unknown verdict is coerced to ERROR');

  const throwing = mountPanel({ port: async () => { throw new Error('boom'); } });
  await throwing.type('SOME-CODE');
  await throwing.submit();
  await settle();
  throwing.render();
  assert.match(throwing.text(), /Something went wrong/, 'a thrown port is the retryable ERROR');

  // The failure copy never names a discount, a duration or an entitlement.
  assert.doesNotMatch(
    stripComments(read(REDEMPTION)),
    /discount|\b\d{1,3}\s?%|\bfree trial|\b\d+-day|entitlement grant/i,
    'no business-policy copy is invented',
  );
});

// ── 9. Success waits for canonical K+ confirmation ───────────────────────────

test('success: a receipt, never a membership -- canonical K+ stays the authority', async () => {
  const ui = mountPanel({ port: async () => 'SUCCESS' });
  await ui.type('WELCOME-2026');
  await ui.submit();
  await settle();
  ui.render();

  assert.ok(ui.has('kplus-redeem-offer-success'));
  assert.match(ui.text(), /Offer received/);
  assert.match(ui.text(), /as soon as it is confirmed/, 'success defers confirmation to the authority');
  assert.doesNotMatch(
    ui.text(),
    /you're k\+|membership is active|now active|unlocked/i,
    'success never represents membership as active',
  );

  // Done leaves the surface.
  ui.node('kplus-redeem-offer-done').props.onPress();
  assert.equal(ui.calls.closes, 1);

  // Announcements: the success was announced to a screen reader.
  assert.ok(
    ui.announcements.some((message) => /Offer received/.test(message)),
    'success is announced, not only drawn',
  );
});

test('failure announcements: the bounded failure copy is announced', async () => {
  const ui = mountPanel({ port: async () => 'INVALID' });
  await ui.type('NOPE');
  await ui.submit();
  await settle();
  assert.ok(
    ui.announcements.some((message) => /Code not recognized/.test(message)),
    'the failure is announced',
  );
});

// ── 4/5/6. The presentation layer holds no codes, no grants, no backends ─────

test('contract: no valid codes, no allowlist, no entitlement mutation, no store/backend calls', () => {
  for (const rel of [PANEL, REDEMPTION]) {
    const source = stripComments(read(rel));

    // No hardcoded valid promo codes and no client-side allowlist. A promo
    // code literal carries a digit or a dash; plain UPPERCASE result-kind
    // constants (SUCCESS, EXPIRED...) are not codes.
    assert.doesNotMatch(source, /===\s*['"](?=[A-Z0-9-]*[0-9-])[A-Z0-9-]{4,}['"]/, `${rel} compares against a literal code`);
    assert.doesNotMatch(source, /\[(?:\s*['"](?=[A-Z0-9-]*[0-9-])[A-Z0-9-]{4,}['"],?\s*){2,}\]/, `${rel} embeds a code allowlist`);
    assert.doesNotMatch(source, /VALID_CODES|ALLOWLIST|KNOWN_CODES/i, `${rel} names a code allowlist`);

    // No entitlement mutation: a redemption result never writes K+ state.
    assert.doesNotMatch(source, /useKPlusEntitlement|setKPlus|isKPlus\s*=|grantEntitlement|\.activate\(/, `${rel} touches entitlement state`);

    // No RevenueCat / Supabase / network inside the presentational seam.
    assert.doesNotMatch(
      source,
      /revenuecat|purchases\.|supabase|functions\.invoke|\bfetch\(|XMLHttpRequest|presentPaywall/i,
      `${rel} makes a store or backend call`,
    );

    // The entered code is never persisted.
    assert.doesNotMatch(source, /AsyncStorage|localStorage|SecureStore|FileSystem/, `${rel} persists the code`);
  }

  // The port contract is exactly the closed verdict set.
  const redemption = runModule(REDEMPTION, {}, { jsx: false });
  assert.deepEqual(
    [...redemption.KPLUS_OFFER_REDEMPTION_RESULTS],
    ['SUCCESS', 'INVALID', 'EXPIRED', 'ALREADY_USED', 'NOT_ELIGIBLE', 'UNAVAILABLE', 'ERROR'],
  );
  assert.equal(typeof redemption.KPLUS_OFFER_REDEMPTION_UNAVAILABLE_PORT, 'function');
  return redemption.KPLUS_OFFER_REDEMPTION_UNAVAILABLE_PORT('X').then((verdict) => {
    assert.equal(verdict, 'UNAVAILABLE', 'the default port answers honestly');
  });
});

// ── Reducer safety properties (pure model, executed) ─────────────────────────

test('reducer: submit only from entry/failed with a code; resolve only from validating', () => {
  const m = runModule(REDEMPTION, {}, { jsx: false });

  // Empty submit is refused.
  let state = m.reduceKPlusRedeemOffer(m.KPLUS_REDEEM_OFFER_INITIAL, { type: 'SUBMIT' });
  assert.equal(state.phase, 'entry');

  // A real submission enters validating; a duplicate SUBMIT is ignored.
  state = m.reduceKPlusRedeemOffer(m.KPLUS_REDEEM_OFFER_INITIAL, { type: 'EDIT', code: ' CODE ' });
  state = m.reduceKPlusRedeemOffer(state, { type: 'SUBMIT' });
  assert.equal(state.phase, 'validating');
  const duplicate = m.reduceKPlusRedeemOffer(state, { type: 'SUBMIT' });
  assert.equal(duplicate, state, 'a second submit mid-flight changes nothing');

  // A stray resolution while not validating is ignored.
  const stray = m.reduceKPlusRedeemOffer(m.KPLUS_REDEEM_OFFER_INITIAL, { type: 'RESOLVED', result: 'SUCCESS' });
  assert.equal(stray.phase, 'entry', 'no resolution is accepted outside validating');

  // Editing mid-flight is ignored; the in-flight code is what was submitted.
  const edited = m.reduceKPlusRedeemOffer(state, { type: 'EDIT', code: 'OTHER' });
  assert.equal(edited, state, 'editing is paused while validating');

  // Success clears any failure; a failure keeps the code for correction.
  const success = m.reduceKPlusRedeemOffer(state, { type: 'RESOLVED', result: 'SUCCESS' });
  assert.equal(success.phase, 'success');
  const failed = m.reduceKPlusRedeemOffer(state, { type: 'RESOLVED', result: 'EXPIRED' });
  assert.deepEqual([failed.phase, failed.failure, failed.code], ['failed', 'EXPIRED', ' CODE ']);
});
