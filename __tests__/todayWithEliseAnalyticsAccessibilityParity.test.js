// Build 5 Phase 2 — analytics allowlist, accessibility, and platform parity.
//
// PRIVACY IS ASSERTED AGAINST THE SINK, not against intent. The Phase 1 sink
// drops any event name and any property outside its allowlist, so the tests
// below feed it prohibited payloads and prove nothing survives.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

if (!Module._extensions['.ts']) {
  Module._extensions['.ts'] = function compileTs(module, filename) {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(out, filename);
  };
}

globalThis.__DEV__ = false;

const analytics = require(path.join(ROOT, 'services/todayWithElise/analytics.ts'));
const reporting = require(path.join(ROOT, 'services/todayWithElise/reporting.ts'));

const hook = fs.readFileSync(path.join(ROOT, 'hooks/useTodayWithElise.ts'), 'utf8');
const card = fs.readFileSync(path.join(ROOT, 'components/home/TodayWithEliseCard.tsx'), 'utf8');
const handoffSource = fs.readFileSync(
  path.join(ROOT, 'services/todayWithElise/handoff.ts'),
  'utf8',
);

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Capture what the real sink actually receives. */
function capture(run) {
  const received = [];
  analytics.setTodayWithEliseAnalyticsSink((event, payload) => received.push({ event, payload }));
  try {
    run();
  } finally {
    analytics.resetTodayWithEliseAnalyticsSink();
  }
  return received;
}

// ── The approved event set ───────────────────────────────────────────────────

const REQUIRED_EVENTS = [
  'today_with_elise_eligible',
  'today_with_elise_impression',
  'today_with_elise_primary_action',
  'today_with_elise_secondary_action',
  'today_with_elise_fallback_rendered',
  'today_with_elise_dressing_room_opened',
  'today_with_elise_look_modified',
  'today_with_elise_look_saved',
  'today_with_elise_partial_look_shown',
];

test('every required Build 5 event is allowlisted by the sink', () => {
  for (const event of REQUIRED_EVENTS) {
    assert.ok(
      analytics.TODAY_WITH_ELISE_EVENTS.includes(event),
      `${event} is not allowlisted`,
    );
  }
});

test('every required event is actually emitted somewhere in Build 5', () => {
  const sources = [
    hook,
    handoffSource,
    fs.readFileSync(path.join(ROOT, 'services/todayWithElise/reporting.ts'), 'utf8'),
  ].join('\n');
  for (const event of REQUIRED_EVENTS) {
    assert.ok(sources.includes(event), `${event} has no emitter`);
  }
});

test('an event name outside the allowlist is dropped entirely', () => {
  const received = capture(() => {
    analytics.emitTodayWithEliseEvent('today_with_elise_secret_upload', { stateId: 'fallback' });
    analytics.emitTodayWithEliseEvent('some_vendor_event', { stateId: 'fallback' });
  });
  assert.equal(received.length, 0);
});

test('a property outside the allowlist is stripped before the sink sees it', () => {
  const received = capture(() => {
    analytics.emitTodayWithEliseEvent('today_with_elise_eligible', {
      stateId: 'today_owned_look',
      actorId: 'actor-a',
      userId: 'actor-a',
      email: 'someone@example.com',
      accessToken: 'ey.token.value',
      imagePath: 'file:///var/mobile/item.jpg',
      closetItemIds: ['item-top'],
      lookContents: [{ slot: 'top' }],
      latitude: 51.5,
      note: 'anything I typed',
    });
  });
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0].payload), ['stateId']);
});

test('no prohibited value can survive in an allowlisted property', () => {
  const received = capture(() => {
    // `source` IS allowlisted, so this proves the value filter, not just the
    // key filter: free text and paths fail the safe-string pattern.
    analytics.emitTodayWithEliseEvent('today_with_elise_eligible', {
      source: 'file:///var/mobile/Containers/item.jpg',
      priority: 'a value with spaces and an @email.com',
      stateId: 'today_owned_look',
    });
  });
  assert.deepEqual(Object.keys(received[0].payload), ['stateId']);
});

test('the committed-card payload carries only bounded enums', () => {
  const payload = reporting.todayEventPayload(
    {
      stateId: 'today_owned_look',
      priority: 'today_owned_look',
      completeness: 'complete',
      source: 'owned_closet_composition',
      analyticsClass: 'eligible',
      weatherDependent: false,
      generationToken: 'today_1_1',
      actorId: 'actor-a',
      itemRefs: [{ closetItemId: 'item-top', slot: 'top' }],
    },
    'ios',
    Date.parse('2026-07-30T09:00:00Z'),
  );
  const received = capture(() => {
    analytics.emitTodayWithEliseEvent('today_with_elise_eligible', payload);
  });
  const delivered = received[0].payload;
  assert.deepEqual(
    Object.keys(delivered).sort(),
    ['analyticsClass', 'completeness', 'daypart', 'platform', 'priority', 'source', 'stateId', 'weatherUsed'],
  );
  const serialized = JSON.stringify(delivered);
  for (const forbidden of ['actor-a', 'item-top', 'today_1_1', 'file://', '@']) {
    assert.ok(!serialized.includes(forbidden), `delivered payload leaked ${forbidden}`);
  }
});

// ── Dedupe ───────────────────────────────────────────────────────────────────

test('an impression is committed once per generation token', () => {
  analytics.__resetTodayWithEliseImpressionDedupe();
  const first = analytics.emitTodayWithEliseImpression({ generationToken: 'today_9_1' });
  const second = analytics.emitTodayWithEliseImpression({ generationToken: 'today_9_1' });
  assert.equal(first, true);
  assert.equal(second, false);
});

test('a new generation reports a new impression', () => {
  analytics.__resetTodayWithEliseImpressionDedupe();
  assert.equal(analytics.emitTodayWithEliseImpression({ generationToken: 'today_9_1' }), true);
  assert.equal(analytics.emitTodayWithEliseImpression({ generationToken: 'today_9_2' }), true);
});

test('the surface reports at most once per committed generation', () => {
  const section = fs.readFileSync(
    path.join(ROOT, 'components/home/TodayWithEliseSection.tsx'),
    'utf8',
  );
  assert.match(section, /if \(reportedRef\.current === token\) return;/);
  assert.match(section, /reportedRef\.current = token;/);
  assert.match(section, /\}, \[token\]\);/);
});

test('a stale or refused result reports nothing, because it never commits', () => {
  const orchestrationPath = hook.slice(
    hook.indexOf('const orchestrate = useCallback'),
    hook.indexOf('// ── Actions ─'),
  );
  // The only publish is guarded by the commit gate; nothing emits inside the
  // generation runner at all.
  assert.doesNotMatch(orchestrationPath, /emitTodayWithElise/);
  assert.match(orchestrationPath, /if \(!committed\) return;/);
});

test('the save and modify observations each report once', () => {
  assert.match(hook, /if \(savedReportedRef\.current === departure\.sessionId\) return;/);
  assert.match(hook, /if \(modifiedReportedRef\.current === departure\.sessionId\) return;/);
});

test('opening the modification flow is not reported as a modification', () => {
  const code = codeOnly(handoffSource);
  assert.match(code, /today_with_elise_secondary_action/);
  assert.doesNotMatch(code, /today_with_elise_look_modified/);
});

test('a refused handoff emits nothing at all', () => {
  const code = codeOnly(handoffSource);
  // Every refusal path returns through `refuse`, which carries an empty event
  // list — emission happens only after the navigation on the success path.
  assert.match(code, /function refuse\([\s\S]*?emitted: \[\] \};/);
});

// ── No external transport ────────────────────────────────────────────────────

test('Build 5 introduces no analytics SDK, vendor or remote configuration', () => {
  const files = fs
    .readdirSync(path.join(ROOT, 'services/todayWithElise'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('services/todayWithElise', name))
    .concat(['hooks/useTodayWithElise.ts', 'components/home/TodayWithEliseSection.tsx']);
  for (const file of files) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert.doesNotMatch(
      source,
      /amplitude|segment|mixpanel|firebase|posthog|sentry|datadog|fetch\(|axios|XMLHttpRequest|supabase/i,
      `${file} reaches an external transport`,
    );
  }
});

test('Build 5 adds no analytics persistence', () => {
  const files = fs
    .readdirSync(path.join(ROOT, 'services/todayWithElise'))
    .filter((name) => name.endsWith('.ts'));
  for (const name of files) {
    const source = codeOnly(
      fs.readFileSync(path.join(ROOT, 'services/todayWithElise', name), 'utf8'),
    );
    assert.doesNotMatch(
      source,
      /AsyncStorage|FileSystem|writeAsStringAsync|SecureStore/,
      `${name} persists analytics`,
    );
  }
});

test('analytics failure never propagates into the render path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/todayWithElise/analytics.ts'), 'utf8');
  assert.match(source, /\} catch \{/);
  analytics.setTodayWithEliseAnalyticsSink(() => {
    throw new Error('sink exploded');
  });
  assert.doesNotThrow(() =>
    analytics.emitTodayWithEliseEvent('today_with_elise_eligible', { stateId: 'fallback' }),
  );
  analytics.resetTodayWithEliseAnalyticsSink();
});

// ── Accessibility ────────────────────────────────────────────────────────────

test('the card exposes a clear Today with Elise label on a real header', () => {
  assert.match(card, /accessibilityRole="header"/);
  assert.match(card, /accessibilityLabel="Today with Elise"/);
});

test('the garment row is one element with meaningful item labels', () => {
  assert.match(card, /accessible\s*\n\s*accessibilityLabel=\{presentation\.accessibilityLabel\}/);
});

test('decorative elements are hidden from assistive technology', () => {
  assert.match(card, /accessibilityElementsHidden/);
  assert.match(card, /importantForAccessibility="no"/);
});

test('every control carries an accessible label', () => {
  const buttons = card.match(/<(PrimaryButton|SecondaryButton)[\s\S]*?\/>/g) ?? [];
  assert.ok(buttons.length >= 2);
  for (const button of buttons) {
    assert.match(button, /accessibilityLabel=/);
  }
});

test('loading announces politely rather than silently', () => {
  assert.match(card, /accessibilityRole="progressbar"/);
  assert.match(card, /accessibilityLiveRegion="polite"/);
});

test('a failure is announced as an alert', () => {
  assert.match(card, /accessibilityRole="alert"/);
});

test('focus order follows the visual order: heading, copy, items, actions', () => {
  const order = ['TODAY_CARD_TEST_IDS.heading', 'presentation.headline', 'presentation.explanation', 'TODAY_CARD_TEST_IDS.items', 'TODAY_CARD_TEST_IDS.primary', 'TODAY_CARD_TEST_IDS.secondary'];
  let previous = -1;
  for (const marker of order) {
    const index = card.indexOf(marker);
    assert.ok(index > previous, `${marker} is out of source order`);
    previous = index;
  }
});

test('nothing is communicated by animation, so reduced motion changes nothing', () => {
  const code = codeOnly(card);
  assert.doesNotMatch(code, /Animated|useNativeDriver|LayoutAnimation|withTiming|withSpring/);
});

test('nothing is communicated by colour alone', () => {
  // A missing slot carries the word "Missing" and its slot name, not just a
  // dashed grey border; a failure carries text, not just a red tint.
  assert.match(card, />\s*Missing\s*</);
  assert.match(card, /\{item\.slotLabel\}/);
  assert.match(card, /\{actionError\}/);
});

test('large text is accommodated rather than truncated', () => {
  assert.doesNotMatch(card, /<Text style=\{styles\.explanation\} numberOfLines/);
  assert.doesNotMatch(card, /<Text style=\{styles\.headline\} numberOfLines/);
  const styles = card.slice(card.indexOf('const styles = StyleSheet.create'));
  assert.doesNotMatch(styles, /card: \{[^}]*height:/);
});

// ── Platform parity ──────────────────────────────────────────────────────────

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/build5-today-with-elise-v1-parity.json'), 'utf8'),
);

test('every platform-neutral Build 5 file matches the parity manifest', () => {
  for (const [file, expected] of Object.entries(manifest.files)) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const actual = crypto.createHash('sha256').update(raw).digest('hex');
    assert.equal(actual, expected, `${file} drifted from the parity manifest`);
  }
});

test('the manifest covers every Build 5 module', () => {
  const modules = fs
    .readdirSync(path.join(ROOT, 'services/todayWithElise'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `services/todayWithElise/${name}`);
  for (const file of modules) {
    assert.ok(manifest.files[file], `${file} is missing from the parity manifest`);
  }
  for (const file of [
    'hooks/useTodayWithElise.ts',
    'components/home/TodayWithEliseCard.tsx',
    'components/home/TodayWithEliseSection.tsx',
    'components/home/TodayWithEliseBoundary.tsx',
    'types/todayWithElise.ts',
  ]) {
    assert.ok(manifest.files[file], `${file} is missing from the parity manifest`);
  }
});

test('no Build 5 module branches on platform except to label an event', () => {
  for (const file of Object.keys(manifest.files)) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const matches = source.match(/Platform\.(OS|select)/g) ?? [];
    for (const match of matches) {
      assert.equal(
        match,
        'Platform.OS',
        `${file} branches on platform beyond the analytics label`,
      );
    }
    assert.doesNotMatch(source, /Platform\.OS\s*===/, `${file} branches on platform`);
  }
});

test('the Home mount is present and identically shaped on this platform', () => {
  const home = fs.readFileSync(
    path.join(ROOT, 'components/home/HomeLuxuryTechV1.tsx'),
    'utf8',
  );
  assert.match(home, /import \{ TodayWithEliseSection \} from '\.\/TodayWithEliseSection';/);
  assert.match(home, /<TodayWithEliseSection \/>/);
  const stylist = home.indexOf('<HomeStylistCard');
  const today = home.indexOf('<TodayWithEliseSection />');
  const picks = home.indexOf('home-luxury-style-picks-section');
  assert.ok(stylist < today && today < picks);
});
