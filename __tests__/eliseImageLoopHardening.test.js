// Analytics and accessibility for the image styling loop (Commit 5).
//
// The properties that matter:
//   * no new transport — the existing bounded sink, unchanged
//   * the payload is five enums, and every forbidden field is rejected BY
//     CONSTRUCTION rather than by anyone remembering not to pass it
//   * an impression is recorded when the offer changes, not on every keystroke
//   * a rapid double tap produces one selection event
//   * saved/not-saved is announced, and Style This Item is discoverable when it
//     appears — without an animation and without a remount
//   * touch targets, focus order and reduced motion hold
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
  const sandbox = { exports: mod.exports, module: mod, require: localRequire, console, __DEV__: false };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const loop = loadModule('services/style-chat/eliseImageStylingLoop.ts');
const telemetry = loadModule('services/closetTelemetry.ts');

const LOOP_EVENTS = [
  'elise_image_followup_shown',
  'elise_image_followup_selected',
  'elise_image_save_prompt_shown',
  'elise_image_save_selected',
  'elise_image_saved',
  'elise_image_style_item_selected',
  'elise_image_dressing_room_opened',
  'elise_image_context_cleared',
  'elise_image_context_replaced',
];

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

function capture() {
  const events = [];
  telemetry.setClosetTelemetrySink((event, payload) => events.push({ event, payload }));
  return events;
}

// ── Transport ────────────────────────────────────────────────────────────────

test('no new analytics transport is introduced', () => {
  const source = read('services/closetTelemetry.ts');
  // One sink, one scrub, one seam — all pre-existing and untouched.
  assert.match(source, /let sink: ClosetTelemetrySink = devSink;/);
  assert.match(source, /const SAFE_STRING = \/\^\[A-Za-z0-9_\.:-\]\{1,64\}\$\//);
  // Word-boundary vendor names, not bare substrings: this module's Mirror
  // comments legitimately mention "segmentation".
  for (const forbidden of [/\bamplitude\b/i, /\bsegment\.(?:io|com)\b/i, /\bfirebase\b/i, /\bmixpanel\b/i, /\bfetch\(/, /\bXMLHttpRequest\b/]) {
    assert.ok(!forbidden.test(source), `no ${forbidden} transport`);
  }
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /from '\.\.\/\.\.\/services\/closetTelemetry'/);
  assert.equal(
    (screen.match(/from '[^']*[Tt]elemetry'/g) ?? []).length,
    1,
    'the loop must use exactly one event sink',
  );
});

test('every loop event is on the allowlist and nothing else is emitted', () => {
  for (const event of LOOP_EVENTS) {
    assert.ok(
      Array.from(telemetry.CLOSET_CANDIDATE_EVENTS).includes(event),
      `${event} must be allowlisted`,
    );
  }
  const screen = read('app/style-chat/[sessionId].tsx');
  const emitted = Array.from(screen.matchAll(/emitClosetCandidateEvent\(\s*'([^']+)'/g)).map(
    (match) => match[1],
  );
  assert.ok(emitted.length > 0, 'the screen must emit loop events');
  for (const event of emitted) {
    assert.ok(LOOP_EVENTS.includes(event), `${event} is not one of this pass's events`);
  }
});

// ── Payload ──────────────────────────────────────────────────────────────────

test('the payload is five enums and carries no identifier or free text', () => {
  const payload = loop.loopTelemetryPayload(ctx());
  assert.equal(
    Array.from(Object.keys(payload)).sort().join(','),
    'attachmentState,closetState,itemCategory,source',
  );
  assert.equal(payload.itemCategory, 'dress');
  assert.equal(payload.attachmentState, 'sent');
  assert.equal(payload.closetState, 'not_saved');
  assert.equal(payload.source, 'elise_chat');

  // The title is on the context and deliberately NOT on the payload: it is a
  // garment name the user may have typed.
  const values = Array.from(Object.values(payload)).join('|');
  assert.ok(!values.includes('Black satin midi dress'));
  assert.ok(!values.includes('att_1'));
  assert.ok(!values.includes('file://'));
});

test('a forbidden field is dropped by the sink, not merely by discipline', () => {
  const events = capture();
  try {
    telemetry.emitClosetCandidateEvent('elise_image_followup_selected', {
      ...loop.loopTelemetryPayload(ctx()),
      actionType: 'prompt',
      // Everything below is exactly what must never be recorded.
      prompt: 'What shoes work with my black satin midi dress?',
      userText: 'my sister is getting married',
      imageUri: 'file:///data/user/0/photo.jpg',
      actorId: 'user-1234',
      closetItemId: '11111111-2222-4333-8444-555555555555',
      candidateId: 'cand-1',
      sessionId: 'sess-1',
      token: 'ey.abc',
      latitude: 47.6,
      fashionContext: { items: [] },
    });
    assert.equal(events.length, 1);
    assert.equal(
      Array.from(Object.keys(events[0].payload)).sort().join(','),
      'actionType,attachmentState,closetState,itemCategory,source',
    );
    const serialized = JSON.stringify(events[0]);
    for (const leak of ['shoes', 'wedding', 'sister', 'file://', 'user-1234', '11111111', 'cand-1', 'sess-1', 'ey.abc', '47.6']) {
      assert.ok(!serialized.includes(leak), `${leak} must never be recorded`);
    }
  } finally {
    telemetry.resetClosetTelemetrySink();
  }
});

test('every enum value survives the scrub', () => {
  const events = capture();
  try {
    for (const categoryBucket of ['dress', 'outerwear', 'footwear', 'top', 'bottom', 'bag', 'accessory', 'other']) {
      for (const attachmentState of ['ready', 'sending', 'sent', 'send_failed']) {
        for (const closetState of ['not_saved', 'saving', 'saved', 'save_failed']) {
          events.length = 0;
          telemetry.emitClosetCandidateEvent(
            'elise_image_followup_shown',
            loop.loopTelemetryPayload(ctx({ categoryBucket, attachmentState, closetState })),
          );
          assert.equal(
            Array.from(Object.keys(events[0].payload)).length,
            4,
            `${categoryBucket}/${attachmentState}/${closetState} lost a property to the scrub`,
          );
        }
      }
    }
    // An action type that the scrub would reject would vanish silently, so every
    // one is proved to survive.
    for (const actionType of ['prompt', 'save_to_closet', 'style_this_item', 'open_dressing_room', 'change_something']) {
      events.length = 0;
      telemetry.emitClosetCandidateEvent('elise_image_followup_selected', {
        ...loop.loopTelemetryPayload(ctx()),
        actionType,
      });
      assert.equal(events[0].payload.actionType, actionType);
    }
  } finally {
    telemetry.resetClosetTelemetrySink();
  }
});

// ── Impression cadence ───────────────────────────────────────────────────────

test('an impression is keyed on the offer, not on renders', () => {
  const base = ctx();
  assert.equal(loop.followUpImpressionKey(base), loop.followUpImpressionKey(ctx()));
  assert.equal(loop.followUpImpressionKey(null), null);

  // Every dimension that changes what is offered changes the key.
  const changed = [
    ctx({ draftId: 'att_2' }),
    ctx({ attachmentState: 'ready' }),
    ctx({ closetState: 'saving' }),
    ctx({ closetState: 'saved', owned: true }),
    ctx({ styled: true }),
  ];
  for (const next of changed) {
    assert.notEqual(loop.followUpImpressionKey(next), loop.followUpImpressionKey(base));
  }

  // A typed character changes neither the context nor the key.
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /const followUpImpressionRef = useRef<string \| null>\(null\);/);
  assert.match(screen, /if \(followUpImpressionRef\.current !== key\) \{/);
  const effect = screen.match(/const key = followUpImpressionKey\(activeItem\);([\s\S]*?)\n  \}, \[activeItem, attachmentsEnabled\]\);/)?.[1] ?? '';
  assert.ok(effect, 'the impression effect must exist');
  assert.ok(!effect.includes('composerText'), 'an impression must not depend on typing');
});

test('the save prompt impression fires only where a save is offered', () => {
  // Before the first answer the row is questions only, so there is no save
  // prompt to record.
  const unsent = ctx({ attachmentState: 'ready' });
  assert.ok(!loop.resolveFollowUpActions(unsent).some((a) => a.type === 'save_to_closet'));
  const answered = ctx({ attachmentState: 'sent' });
  assert.ok(loop.resolveFollowUpActions(answered).some((a) => a.type === 'save_to_closet'));

  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(
    screen,
    /if \(resolveFollowUpActions\(activeItem\)\.some\(\(action\) => action\.type === 'save_to_closet'\)\) \{\s*emitClosetCandidateEvent\('elise_image_save_prompt_shown'/,
  );
});

test('a rapid double tap produces one selection event', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  const handler =
    screen.match(/const openDressingRoomForActiveItem = useCallback\(([\s\S]*?)\n  \}, \[/)?.[1] ?? '';
  // Emitted AFTER the latch is claimed, so the second tap returns before it.
  const latch = handler.indexOf('styleHandoffRef.current = true');
  const emit = handler.indexOf("emitClosetCandidateEvent('elise_image_style_item_selected'");
  assert.ok(latch > -1 && emit > -1 && latch < emit, 'the latch must be claimed before the event');
  assert.equal(
    (handler.match(/elise_image_style_item_selected/g) ?? []).length,
    1,
    'one selection event per accepted tap',
  );
  assert.equal(
    (handler.match(/elise_image_dressing_room_opened/g) ?? []).length,
    1,
    'one navigation event, on the success path only',
  );
});

// ── Accessibility ────────────────────────────────────────────────────────────

test('the Closet transition is announced, and says what it unlocked', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /AccessibilityInfo\.announceForAccessibility\(/);
  assert.match(screen, /ELISE_IMAGE_LOOP_COPY\.styleThisItemLabel\} is now available/);
  // Not on first observation: re-entering the screen must not announce a state
  // the user already knows.
  assert.match(screen, /if \(previous !== null && previous !== closetLine\)/);
});

test('state is carried by text, never by motion', () => {
  for (const rel of [
    'components/style-chat/StyleChatActiveItemBar.tsx',
    'components/style-chat/StyleChatFollowUpBar.tsx',
  ]) {
    const source = read(rel);
    for (const forbidden of ['Animated', 'LayoutAnimation', 'useNativeDriver', 'withTiming', 'Easing']) {
      assert.ok(!source.includes(forbidden), `${rel} must not depend on ${forbidden}`);
    }
  }
});

test('every control has an accessible name, a role and a disabled state', () => {
  const bar = read('components/style-chat/StyleChatActiveItemBar.tsx');
  assert.equal((bar.match(/accessibilityRole="button"/g) ?? []).length, 2);
  assert.equal((bar.match(/accessibilityLabel=/g) ?? []).length, 3);
  assert.equal((bar.match(/accessibilityState=\{\{ disabled: Boolean\(disabled\) \}\}/g) ?? []).length, 2);
  // The row announces once as a whole rather than as three fragments, and the
  // thumbnail is not announced twice.
  assert.match(bar, /accessibilityRole="summary"/);
  assert.match(bar, /accessibilityElementsHidden/);
  assert.match(bar, /importantForAccessibility="no"/);

  const followUps = read('components/style-chat/StyleChatFollowUpBar.tsx');
  assert.match(followUps, /accessibilityRole="button"/);
  assert.match(followUps, /accessibilityLabel=\{action\.accessibilityLabel\}/);
  assert.match(followUps, /accessibilityState=\{\{ disabled: isDisabled, busy: action\.busy === true \}\}/);

  // Every action the resolver can produce carries a name.
  for (const owned of [false, true]) {
    for (const styled of [false, true]) {
      for (const action of loop.resolveFollowUpActions(
        ctx({ owned, styled, closetState: owned ? 'saved' : 'not_saved' }),
      )) {
        assert.ok(action.accessibilityLabel.trim().length > 0, `${action.id} needs a name`);
      }
    }
  }
});

test('touch targets clear the platform minimum', () => {
  const followUps = read('components/style-chat/StyleChatFollowUpBar.tsx');
  assert.match(followUps, /minHeight: 44/);

  const bar = read('components/style-chat/StyleChatActiveItemBar.tsx');
  // 28px control + 10px slop per edge = 48dp effective.
  assert.match(bar, /hitSlop=\{\{ top: 10, bottom: 10, left: 10, right: 10 \}\}/);
  assert.match(bar, /width: 28,\s*height: 28,/);
});

test('large text truncates instead of pushing controls off the row', () => {
  const bar = read('components/style-chat/StyleChatActiveItemBar.tsx');
  // The flex column must be allowed to shrink; a row whose text column cannot
  // shrink is what pushed the Closet grid off-screen in Build 25.
  assert.match(bar, /meta: \{ flex: 1, flexShrink: 1, minWidth: 0/);
  assert.match(bar, /actions: \{[^}]*flexShrink: 0/);
  assert.match(bar, /numberOfLines=\{2\}/);
  for (const forbidden of [/width: \d+,\s*\n\s*height: \d+,\s*\n\s*borderRadius: 14/]) {
    assert.ok(forbidden.test(bar), 'the clear control keeps a fixed, known size');
  }
  // The follow-up row scrolls rather than clipping when labels grow.
  const followUps = read('components/style-chat/StyleChatFollowUpBar.tsx');
  assert.match(followUps, /<ScrollView\s+horizontal/);
});

test('focus order follows reading order: context, follow-ups, composer', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  const activeBar = screen.indexOf('<StyleChatActiveItemBar');
  const followUps = screen.indexOf('<StyleChatFollowUpBar');
  const attachments = screen.indexOf('<StyleChatAttachmentBar');
  const composer = screen.indexOf('<StyleChatInput');
  assert.ok(activeBar > -1 && followUps > -1 && attachments > -1 && composer > -1);
  assert.ok(activeBar < followUps, 'the item is named before the actions about it');
  assert.ok(followUps < attachments, 'the follow-ups sit above the composer controls');
  assert.ok(attachments < composer);
});
