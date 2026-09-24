/**
 * K+ signup activation screen (onboarding step 6).
 *
 * WHAT THIS SUITE IS PROTECTING.
 *
 * The activation screen is the one place in the product where a commercial
 * claim, an entitlement state, and a dismissal path meet. Each of the three
 * has a way of failing that no amount of sighted QA reliably catches:
 *
 *   - a COMMERCIAL claim can drift into urgency the campaign does not carry
 *     ("limited time", "expires tonight"), which is a truthfulness problem
 *     long before it is a store-review problem;
 *   - an UNRESOLVED entitlement can render as the free tier, which tells a
 *     paying/complimentary member they do not have K+ because their network
 *     blipped. It looks identical to the correct screen;
 *   - a DISMISSAL path can quietly decay -- lower contrast, a smaller target,
 *     an extra screen, guilt copy -- one small change at a time.
 *
 * Two of those three are invisible in a screenshot, so they are pinned here as
 * source-level assertions, in the convention welcomeRouting.test.js and
 * onboardingHandoffRecovery.test.js already use for TSX screens that cannot be
 * mounted under node:test. The pure-TS modules (the capability catalog and the
 * offer-term config) are executed for real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

function loadModule(absPath, requireMap = {}) {
  const output = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    process: { env: {} },
    __DEV__: false,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

/** vm-loaded modules return objects built against the sandbox realm's
 *  prototypes, so assert/strict's deepEqual rejects them on prototype identity
 *  alone. Compare the DATA, not the realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const screen = read('components', 'kplus', 'KPlusActivationStep.tsx');
const onboarding = read('app', 'onboarding', 'index.tsx');
const catalogSource = read('services', 'kplus', 'kplusActivationCatalog.ts');
const flagsSource = read('constants', 'featureFlags.ts');

/** Source with comments removed. Every assertion about what the screen SAYS or
 *  DOES must run against this -- otherwise a forbidden phrase sitting in a
 *  comment (like the ones in this file) would fail the suite, and a rule
 *  described in a comment would satisfy a test that meant to check the code. */
const code = screen
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // Negative lookbehind so `https://...` survives the line-comment strip.
  .replace(/(?<!:)\/\/.*$/gm, '');

const catalog = loadModule(path.join(ROOT, 'services', 'kplus', 'kplusActivationCatalog.ts'), {
  '../../constants/featureFlags': {
    VOICESCAN_ENABLED: false,
    VTO_UI_ENABLED: false,
    ELISE_CONCIERGE_V1: false,
    PACKING_INTELLIGENCE_V1: false,
  },
});

// ── CAPABILITY_LIST ─────────────────────────────────────────────────────────

test('CAPABILITY_LIST: the approved K+ catalog is exactly the four capabilities', () => {
  const ids = plain(catalog.KPLUS_ACTIVATION_CAPABILITIES.map((c) => c.id));
  assert.deepEqual(ids, [
    'voice_scan',
    'virtual_try_on',
    'wardrobe_concierge',
    'packing_intelligence',
  ]);

  const titles = plain(catalog.KPLUS_ACTIVATION_CAPABILITIES.map((c) => c.title));
  assert.deepEqual(titles, [
    'Voice Scan',
    'Virtual Try-On',
    'Wardrobe Concierge',
    'Packing Intelligence',
  ]);
});

test('CAPABILITY_LIST: every capability ships one concrete, non-empty line of copy', () => {
  for (const capability of catalog.KPLUS_ACTIVATION_CAPABILITIES) {
    assert.ok(capability.description.length > 0, `${capability.id} needs copy`);
    assert.ok(
      capability.description.length <= 60,
      `${capability.id} copy must stay one scannable line`,
    );
  }
});

test('SMART_WATCHLIST: is not part of the signup activation offer', () => {
  const ids = catalog.KPLUS_ACTIVATION_CAPABILITIES.map((c) => c.id).join(' ');
  assert.doesNotMatch(ids, /watch/i);
  // Nor may the screen name it directly.
  assert.doesNotMatch(code, /Watchlist/i);
});

test('SIGNATURE_STYLE: is presented as core/Free and never as a K+ capability', () => {
  const kplusIds = catalog.KPLUS_ACTIVATION_CAPABILITIES.map((c) => c.id);
  assert.ok(!kplusIds.includes('signature_style'));
  const kplusTitles = catalog.KPLUS_ACTIVATION_CAPABILITIES.map((c) => c.title);
  assert.ok(!kplusTitles.some((t) => /signature/i.test(t)));

  assert.ok(
    catalog.KSCAN_FREE_CORE_CAPABILITIES.includes('Signature Style'),
    'Signature Style must be named as part of what Free keeps',
  );
});

/**
 * Build 34 Lane A. A capability is advertised only when the build compiled it
 * in AND production is known to serve it (KPLUS_CAPABILITY_SERVER_ENABLEMENT).
 * The tests below that are about the BUILD-FLAG half of that rule hold the
 * server half open by passing this all-confirmed record, so they keep proving
 * exactly what they always did. The server half has its own suite:
 * kplusCapabilityAdvertisingTruth.test.js.
 */
const ALL_SERVER_CONFIRMED = Object.fromEntries(
  ['voice_scan', 'virtual_try_on', 'wardrobe_concierge', 'packing_intelligence'].map((id) => [
    id,
    { status: 'confirmed', basis: 'test fixture' },
  ]),
);

test('CAPABILITY_LIST: a build only advertises capabilities it actually compiled in', () => {
  // Nothing built -> nothing promised. This is the case that stops the screen
  // selling VTO to a build that shipped without VTO.
  assert.deepEqual(plain(catalog.resolveActivationCapabilities({}, ALL_SERVER_CONFIRMED)), []);

  const voiceOnly = catalog.resolveActivationCapabilities(
    {
      voiceScan: true,
      vto: false,
      concierge: false,
      packing: false,
    },
    ALL_SERVER_CONFIRMED,
  );
  assert.deepEqual(plain(voiceOnly.map((c) => c.id)), ['voice_scan']);

  const all = catalog.resolveActivationCapabilities(
    {
      voiceScan: true,
      vto: true,
      concierge: true,
      packing: true,
    },
    ALL_SERVER_CONFIRMED,
  );
  assert.equal(all.length, 4);
  assert.ok(all.every((c) => c.available === true));
});

test('CAPABILITY_LIST: the catalog cannot be mutated by a consumer', () => {
  assert.throws(() => {
    catalog.KPLUS_ACTIVATION_CAPABILITIES.push({ id: 'x' });
  });
  assert.equal(catalog.KPLUS_ACTIVATION_CAPABILITIES.length, 4);
});

// ── COMMERCIAL TERMS ────────────────────────────────────────────────────────

test('COMMERCIAL_TERMS_HARDCODED=NO: the offer term is configuration, not UI literal', () => {
  assert.match(code, /KPLUS_ACTIVATION_OFFER_TERM/);
  // The duration must not be written into the screen anywhere.
  assert.doesNotMatch(code, /6\s*months/i);
  assert.doesNotMatch(catalogSource, /6\s*months/i);
});

test('COMMERCIAL_TERMS: the offer term resolver is presentation-only and env-driven', () => {
  const resolver = flagsSource.match(
    /export function resolveKPlusActivationOfferTerm\(([\s\S]*?)\n}/,
  );
  assert.ok(resolver, 'the offer term must have a single configuration resolver');
  assert.match(resolver[1], /EXPO_PUBLIC_KPLUS_ACTIVATION_OFFER_TERM/);

  // It returns a STRING for display. It must not compute dates, grants, or
  // entitlement of any kind.
  assert.doesNotMatch(resolver[1], /Date|expires|grant|entitle/i);
});

test('COMMERCIAL_TERMS: an unset campaign renders no offer line rather than a guess', () => {
  const flags = loadModule(path.join(ROOT, 'constants', 'featureFlags.ts'), {});
  // undefined is what an unset EXPO_PUBLIC_KPLUS_ACTIVATION_OFFER_TERM resolves
  // to -- this must render nothing, never a hardcoded duration guess.
  assert.equal(flags.resolveKPlusActivationOfferTerm(undefined), '');
  assert.equal(flags.resolveKPlusActivationOfferTerm(''), '');
  assert.equal(flags.resolveKPlusActivationOfferTerm('  '), '');
  assert.equal(flags.resolveKPlusActivationOfferTerm('6 months included'), '6 months included');
  assert.equal(flags.resolveKPlusActivationOfferTerm('3 months included'), '3 months included');

  // And the screen must actually respect an empty term.
  assert.match(code, /offerAvailable && offerTerm \?/);
});

test('no dollar amount or price is stated anywhere on the activation screen', () => {
  assert.doesNotMatch(code, /\$\s*\d/);
  assert.doesNotMatch(code, /\bper (?:month|year)\b/i);
  assert.doesNotMatch(code, /\b(?:USD|price|pricing)\b/i);
});

// ── FAKE_SCARCITY_PRESENT=NO ────────────────────────────────────────────────

test('FAKE_SCARCITY_PRESENT=NO: no urgency copy the campaign does not carry', () => {
  const forbidden = [
    /limited time/i,
    /only today/i,
    /last chance/i,
    /expires tonight/i,
    /act now/i,
    /hurry/i,
    /spots? left/i,
    /don't miss/i,
    /while supplies last/i,
    /ends soon/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(code, pattern, `forbidden urgency copy: ${pattern}`);
  }
});

test('the screen uses activation framing, not purchase-pressure framing', () => {
  assert.match(code, /Activate K\+/);
  for (const banned of [/Buy Now/i, /Subscribe Now/i, /Upgrade Now/i, /Start Free Trial/i]) {
    assert.doesNotMatch(code, banned, `banned CTA wording: ${banned}`);
  }
});

test('HEADLINE and OFFER framing match the approved activation copy', () => {
  assert.match(code, /Your K\+ access is ready/);
  // Build 34 Lane A. The sub-headline used to be one fixed sentence naming
  // "scan, style, try on, and plan", which is only true when all four
  // capabilities are advertised -- and production does not serve two of them.
  // It is now derived from the capabilities actually on the screen (see
  // kplusCapabilityAdvertisingTruth.test.js), so the approved sentence is
  // asserted where it is still true: byte-for-byte when all four are advertised.
  assert.match(code, /activationOfferSubhead\(capabilities\)/);
  assert.equal(
    catalog.activationOfferSubhead(
      catalog.resolveActivationCapabilities(
        { voiceScan: true, vto: true, concierge: true, packing: true },
        ALL_SERVER_CONFIRMED,
      ),
    ),
    'Unlock more ways to scan, style, try on, and plan with K Scan AI.',
  );
});

// ── ENTITLEMENT STATES ──────────────────────────────────────────────────────

test('RESOLVING_NEVER_FREE: an unresolved entitlement shows neither the offer nor Free framing', () => {
  assert.match(
    code,
    /const resolving = isKPlusEntitlementUnresolved\(state\)/,
    'the screen must use the single shared unresolved predicate, not its own',
  );
  // It must not re-derive the unresolved set locally.
  assert.doesNotMatch(code, /state === 'loading'/);

  // The unresolved branch must return BEFORE any offer is built.
  const resolvingReturn = code.indexOf('if (resolving)');
  const offerAvailable = code.indexOf("const offerAvailable = state === 'eligible'");
  assert.notEqual(resolvingReturn, -1, 'an unresolved branch must exist');
  assert.notEqual(offerAvailable, -1, 'the offer must be state-derived');
  assert.ok(
    resolvingReturn < offerAvailable,
    'the unresolved branch must short-circuit before the offer is computed',
  );

  const resolvingBranch = code.slice(resolvingReturn, offerAvailable);
  assert.doesNotMatch(resolvingBranch, /Activate K\+/, 'no activation CTA while unresolved');
  assert.doesNotMatch(resolvingBranch, /K Scan AI Free/, 'no free framing while unresolved');
});

test('ENTITLEMENT_ERROR: a failed read is not classified as Free', () => {
  // 'error' is routed through the same unresolved branch as 'loading'.
  const flags = loadModule(path.join(ROOT, 'types', 'entitlements.ts'), {});
  assert.equal(flags.isKPlusEntitlementUnresolved('error'), true);
  assert.equal(flags.isKPlusEntitlementUnresolved('loading'), true);

  // The error presentation must offer a way forward without ever claiming the
  // actor is on the free tier.
  assert.match(code, /kplus-activation-retry-button/);
  assert.match(code, /Continue to K Scan AI/);
});

test('EXISTING_KPLUS_BYPASSES_PAYWALL: an active member is never shown the offer', () => {
  assert.match(code, /const nothingToOffer = isActive \|\| state === 'unavailable'/);
  assert.match(code, /if \(nothingToOffer && !resolving\) onSkip\(\)/);

  // And the skip must be evaluated before the offer render path.
  const skip = code.indexOf('if (nothingToOffer) {');
  const offer = code.indexOf("const offerAvailable = state === 'eligible'");
  assert.ok(skip !== -1 && skip < offer, 'the skip branch must precede the offer');
});

test('an expired campaign is not re-offered as if it were a renewal', () => {
  assert.match(code, /const offerAvailable = state === 'eligible'/);
  // 'expired' therefore falls through to bounded, truthful copy with no CTA.
  assert.match(code, /There is no charge and nothing to cancel/);
});

test('campaign_consumed is never announced as a successful activation', () => {
  const consumed = code.indexOf("if (outcome === 'campaign_consumed')");
  const completed = code.indexOf("emitKPlusEvent('kplus_activation_completed'");
  assert.ok(consumed !== -1, 'campaign_consumed must be handled explicitly');
  assert.ok(
    consumed < completed,
    'campaign_consumed must return before the completion event and success announcement',
  );
});

// ── CONTINUE_FREE ───────────────────────────────────────────────────────────

test('CONTINUE_FREE: the free path is present, labelled, and reaches the app', () => {
  assert.match(code, /Continue with K Scan AI Free/);
  assert.match(code, /testID="kplus-activation-continue-free-button"/);
  assert.match(code, /accessibilityRole="button"/);
  assert.match(code, /onPress=\{handleContinueFree\}/);
  assert.match(code, /const handleContinueFree = \(\) => \{[\s\S]*?onContinue\(\);/);
});

test('CONTINUE_FREE: dismissal is not accessibility-disadvantaged or guilt-laden', () => {
  const freeButton = code.slice(
    code.indexOf('testID="kplus-activation-continue-free-button"'),
    code.indexOf('kplus-activation-legal'),
  );
  assert.match(freeButton, /accessibilityLabel="Continue with K Scan AI Free"/);
  assert.match(freeButton, /accessibilityHint=/);

  // A real target, not a hairline of text.
  const secondary = code.match(/secondaryAction: \{([\s\S]*?)\n  \},/);
  assert.ok(secondary, 'the free control needs its own style block');
  const minHeight = Number(secondary[1].match(/minHeight: (\d+)/)?.[1]);
  assert.ok(minHeight >= 44, `free CTA target must be >= 44dp, got ${minHeight}`);

  // No guilt / loss-framing copy anywhere on the screen.
  for (const guilt of [
    /are you sure/i,
    /you'll lose/i,
    /miss out/i,
    /no thanks,? I/i,
    /downgrade/i,
  ]) {
    assert.doesNotMatch(code, guilt, `guilt copy: ${guilt}`);
  }
});

test('FREE_REASSURANCE_PRESENT: declining never reads as losing K Scan AI', () => {
  assert.match(
    catalog.KPLUS_FREE_REASSURANCE,
    /core K Scan AI Free experience/,
    'the reassurance line must state that Free remains available',
  );
  assert.match(code, /KPLUS_FREE_REASSURANCE/);
  assert.match(code, /KSCAN_FREE_CORE_CAPABILITIES/);

  // The named Free surfaces are core, and core is never gated.
  assert.deepEqual(plain(catalog.KSCAN_FREE_CORE_CAPABILITIES), [
    'Scanner',
    'Shopping',
    'Closet',
    'Signature Style',
    'Elise',
    'Dressing Rooms',
  ]);
});

// ── ACTIVATE_KPLUS ──────────────────────────────────────────────────────────

test('ACTIVATE_KPLUS: activation goes through the existing server-authoritative flow', () => {
  // The screen calls the shared hook's activate(); it never mints, extends or
  // computes a grant, and never talks to a store SDK.
  assert.match(code, /const \{ state, isActive, activate, refresh \} = useKPlusEntitlement\(\)/);
  assert.match(code, /const outcome = await activate\(\)/);

  assert.doesNotMatch(code, /Purchases|RevenueCat|revenuecat/i, 'no store SDK on this screen');
  assert.doesNotMatch(code, /user_entitlements/, 'no direct entitlement table access');
  assert.doesNotMatch(code, /kplus-activate/, 'the edge function is the client module’s job');
  assert.doesNotMatch(code, /expiresAt\s*=/, 'the screen never computes an expiry');
});

// ── ACCESS CODE ─────────────────────────────────────────────────────────────

test('ACCESS_CODE: no client-side access-code logic is introduced', () => {
  // There is no shipped access-code redemption flow in this build -- no route,
  // no client module, no Edge Function. Rather than ship a CTA that leads
  // nowhere, the affordance is absent. What this test pins is the part that
  // would be a DEFECT either way: the screen must never implement redemption
  // itself. When a server-side flow is authorized, the CTA can be added here
  // and this assertion still holds.
  assert.doesNotMatch(code, /redeem|redemption/i);
  assert.doesNotMatch(code, /grantReason|campaignKey|campaign_key/);

  const edgeFunctions = fs.readdirSync(path.join(ROOT, 'supabase', 'functions'));
  assert.ok(
    !edgeFunctions.some((name) => /access.?code|redeem/i.test(name)),
    'if an access-code Edge Function now exists, the CTA can be wired and this test updated',
  );
});

// ── LEGAL_LINKS ─────────────────────────────────────────────────────────────

test('LEGAL_LINKS: privacy, terms and billing point at the canonical destinations', () => {
  assert.match(code, /https:\/\/kscan\.app\/legal\/privacy/);
  assert.match(code, /https:\/\/kscan\.app\/legal\/terms/);
  assert.match(code, /https:\/\/kscan\.app\/billing/);
  assert.match(code, /Billing, Cancellation & Refunds/);

  // Privacy/Terms must agree with the authority already used at the Terms step.
  assert.match(onboarding, /https:\/\/kscan\.app\/legal\/terms/);
  assert.match(onboarding, /https:\/\/kscan\.app\/legal\/privacy/);
});

test('LEGAL_LINKS: each link is a real, reachable, labelled target', () => {
  const legal = code.slice(code.indexOf('kplus-activation-legal'));
  assert.match(legal, /accessibilityRole="link"/);
  assert.match(legal, /Linking\.openURL\(link\.url\)/);

  const target = code.match(/legalLinkTarget: \{([\s\S]*?)\n  \},/);
  assert.ok(target, 'legal links need their own target style');
  const minHeight = Number(target[1].match(/minHeight: (\d+)/)?.[1]);
  assert.ok(minHeight >= 44, `legal link target must be >= 44dp, got ${minHeight}`);
});

// ── ONBOARDING SEQUENCE ─────────────────────────────────────────────────────

test('the activation step runs AFTER authentication, never before', () => {
  // Step 3 is account creation; the activation step is 6, reached only from
  // the permissions step (5).
  assert.match(onboarding, /\| 6 {2}\/\/ K\+ Activation/);
  assert.match(onboarding, /\| 7; \/\/ Home Handoff/);
  assert.match(onboarding, /const goToKPlusActivation = useCallback\(\(\) => \{\n {4}setStep\(6\);/);
  assert.match(onboarding, /onContinueToHome=\{goToKPlusActivation\}/);
  assert.match(onboarding, /onNotNow=\{goToKPlusActivation\}/);

  // And both of its exits lead into the existing completion handoff.
  assert.match(onboarding, /<KPlusActivationStep onContinue=\{goToHome\} onSkip=\{goToHome\} \/>/);
});

test('the step count is consistent across the shell, the indicator and the union', () => {
  assert.match(read('components', 'onboarding', 'OnboardingShell.tsx'), /totalSteps = 7/);
  assert.match(read('components', 'onboarding', 'OnboardingStepIndicator.tsx'), /totalSteps = 7/);
  assert.match(onboarding, /type OnboardingStep\s*=[\s\S]*\| 7;/);
});

// ── ANALYTICS ───────────────────────────────────────────────────────────────

test('ANALYTICS: the screen reuses the governed K+ event family and adds nothing', () => {
  const telemetry = read('services', 'kplus', 'kplusTelemetry.ts');
  for (const event of [
    'kplus_early_access_viewed',
    'kplus_activation_started',
    'kplus_activation_completed',
    'kplus_activation_failed',
  ]) {
    assert.match(telemetry, new RegExp(`'${event}'`), `${event} must be governed`);
    assert.match(code, new RegExp(`'${event}'`), `${event} must be emitted by the screen`);
  }

  // Every event this screen emits must already exist in the approved
  // vocabulary. A presentation change may not widen the measurement contract.
  const governed = loadModule(path.join(ROOT, 'services', 'kplus', 'kplusTelemetry.ts'), {
    '../../types/kplusSource': loadModule(path.join(ROOT, 'types', 'kplusSource.ts'), {}),
  });
  const emitted = [...code.matchAll(/emitKPlusEvent\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(emitted.length > 0, 'the screen must emit the funnel events');
  for (const event of emitted) {
    assert.ok(
      plain(governed.KPLUS_EVENTS).includes(event),
      `${event} is not in the governed K+ vocabulary`,
    );
  }

  // No second analytics family.
  assert.doesNotMatch(code, /posthog|PostHog|analytics\.track/i);
});

test('ANALYTICS: a decline stays derivable as viewed-without-started', () => {
  // The approved vocabulary has no decline event, so the screen must not invent
  // one -- but the decline must still be measurable. That holds only while the
  // view event fires on presentation and the start event fires solely on
  // activation; if either moved, view-minus-start would stop meaning "declined".
  const viewEffect = code.slice(
    code.indexOf('if (resolving || nothingToOffer || viewedRef.current) return;'),
    code.indexOf('const handleActivate'),
  );
  assert.match(viewEffect, /kplus_early_access_viewed/);
  assert.match(viewEffect, /viewedRef\.current = true/, 'one view event per presentation');

  const handleActivate = code.slice(
    code.indexOf('const handleActivate'),
    code.indexOf('const handleContinueFree'),
  );
  assert.match(handleActivate, /kplus_activation_started/);

  const handleContinueFree = code.slice(
    code.indexOf('const handleContinueFree'),
    code.indexOf('if (resolving) {'),
  );
  assert.doesNotMatch(handleContinueFree, /emitKPlusEvent/, 'declining emits no new event');
  assert.match(handleContinueFree, /onContinue\(\)/, 'declining must still reach the app');
});

test('ANALYTICS: no PII reaches the K+ sink from this screen', () => {
  const telemetry = loadModule(path.join(ROOT, 'services', 'kplus', 'kplusTelemetry.ts'), {
    '../../types/kplusSource': loadModule(path.join(ROOT, 'types', 'kplusSource.ts'), {}),
  });

  const captured = [];
  telemetry.setKPlusAnalyticsSink((event, payload) => captured.push([event, payload]));
  telemetry.emitKPlusEvent('kplus_early_access_viewed', {
    source: 'onboarding',
    feature: 'onboarding',
    entitlement_state: 'eligible',
    // Everything below is what a careless caller might add. None of it may
    // survive the allowlist.
    email: 'someone@example.com',
    user_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    closet_items: 'black wool coat',
  });
  telemetry.resetKPlusAnalyticsSink();

  assert.equal(captured.length, 1);
  const [event, payload] = captured[0];
  assert.equal(event, 'kplus_early_access_viewed');
  assert.deepEqual(plain(payload), {
    source: 'onboarding',
    feature: 'onboarding',
    entitlement_state: 'eligible',
  });

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /example\.com/);
  assert.doesNotMatch(serialized, /7c9e6679/);
  assert.doesNotMatch(serialized, /wool coat/);
});

test('ANALYTICS: the screen labels itself with the bounded onboarding source', () => {
  const sources = loadModule(path.join(ROOT, 'types', 'kplusSource.ts'), {});
  assert.ok(sources.KPLUS_SOURCES.includes('onboarding'));
  assert.match(code, /source: 'onboarding'/);
  // No free-form source strings.
  const emitted = [...code.matchAll(/source: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(emitted.length > 0);
  for (const value of emitted) {
    assert.ok(sources.KPLUS_SOURCES.includes(value), `unbounded source: ${value}`);
  }
});

// ── ACCESSIBILITY / LAYOUT ──────────────────────────────────────────────────

test('SCREEN_READER: the headline is a header and every card carries its own name', () => {
  assert.match(code, /accessibilityRole="header"/);
  assert.match(
    code,
    /accessibilityLabel=\{`\$\{capability\.title\}\. \$\{capability\.description\}`\}/,
  );
});

test('SCREEN_READER: the capability glyph is decorative, never announced as content', () => {
  assert.match(code, /importantForAccessibility="no"/);
  assert.match(code, /accessibilityElementsHidden/);
});

test('DYNAMIC_TYPE: no fixed heights or scaling caps that would clip large text', () => {
  // A capped multiplier or a fixed row height is how a screen silently breaks
  // at accessibility sizes. Text must be free to grow.
  assert.doesNotMatch(code, /maxFontSizeMultiplier/);
  assert.doesNotMatch(code, /allowFontScaling=\{false\}/);
  assert.doesNotMatch(code, /numberOfLines/);

  // The only fixed dimensions belong to the decorative glyph badge, which
  // carries no text that needs to scale.
  const fixedHeights = [...code.matchAll(/\n\s{4}height: (\d+),/g)].map((m) => m[1]);
  assert.deepEqual(fixedHeights, ['44'], 'only the decorative glyph badge may be fixed height');
});

test('SMALL_SCREEN: the step scrolls inside the shared onboarding shell', () => {
  // The screen itself must not introduce a second scroll container; the
  // onboarding shell already provides one with safe-area clearance.
  assert.doesNotMatch(code, /ScrollView|FlatList|SafeAreaView/);

  const shell = read('components', 'onboarding', 'OnboardingShell.tsx');
  assert.match(shell, /ScrollView/);
  assert.match(shell, /getOnboardingBottomClearance/);
});
