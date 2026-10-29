'use strict';

// Offline tests for the #639 activation probe's parsing and verdict logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseActivationRows,
  evaluate,
} = require('../security/release/run-instruction-activation-live-probe');

const ON_ROWS = [
  { event_message: '[elise_brand_voice] version=elise-brand-voice-v1 enabled=true attached=true' },
  { event_message: '[scan-identify] image_mission version=scan-image-product-mission-v1 enabled=true request_mode=legacy_single_item attached=true' },
  { event_message: '[scan-identify] gemini_start timeoutMs=12000 model=gemini-3.6-flash mode=image source=scanner_camera' },
  { event_message: '[scan-identify] image_mission version=scan-image-product-mission-v1 enabled=true request_mode=multi_item_detection attached=true' },
  { event_message: '[scan-identify] gemini_start timeoutMs=12000 model=gemini-3.6-flash mode=image source=scanner_camera' },
  { event_message: '[scan-identify] image_mission version=scan-image-product-mission-v1 enabled=true request_mode=selected_item attached=true' },
  { event_message: '[scan-identify] gemini_start timeoutMs=12000 model=gemini-3.6-flash mode=image source=scanner_camera' },
  { event_message: '[scan-identify] gemini_start timeoutMs=8000 model=gemini-3.5-flash-lite mode=text source=text' },
  { event_message: 'unrelated line with user@example.com' },
];

const OK_RESPONSES = {
  elise: { httpStatus: 200, status: 'success', replyLength: 120, capabilities: ['attachments', 'structured_actions'], actionsIsArray: true },
  legacy: { httpStatus: 200, status: 'identified' },
  detect: { httpStatus: 200, v2Status: 'candidates', candidateCount: 2 },
  selected: { httpStatus: 200, v2Status: 'identified', candidateCount: 1 },
  text: { httpStatus: 200, status: 'identified' },
};

test('parses only allowlisted structural tokens', () => {
  const logs = parseActivationRows(ON_ROWS);
  assert.equal(logs.elise.length, 1);
  assert.equal(logs.imageMission.length, 3);
  assert.equal(logs.geminiStart.filter((l) => l.mode === 'text').length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /example\.com/);
});

test('all flags on, every image call attached, TextScan isolated => PASS', () => {
  const verdict = evaluate({ logs: parseActivationRows(ON_ROWS), ...OK_RESPONSES });
  assert.equal(verdict.pass, true, JSON.stringify(verdict.checks.filter((c) => !c.pass)));
});

test('flag-off lines fail the activation checks', () => {
  const offRows = ON_ROWS.map((r) => ({ event_message: r.event_message.replace(/enabled=true/g, 'enabled=false').replace(/attached=true/g, 'attached=false') }));
  const verdict = evaluate({ logs: parseActivationRows(offRows), ...OK_RESPONSES });
  assert.equal(verdict.pass, false);
  const failed = verdict.checks.filter((c) => !c.pass).map((c) => c.name);
  assert.ok(failed.includes('elise_brand_voice_enabled_and_attached'));
  assert.ok(failed.includes('image_mission_enabled_and_attached_every_image_call'));
});

test('an image mission line for a text-mode request breaks isolation', () => {
  const leaked = [...ON_ROWS, { event_message: ON_ROWS[1].event_message }];
  const verdict = evaluate({ logs: parseActivationRows(leaked), ...OK_RESPONSES });
  assert.equal(verdict.checks.find((c) => c.name === 'textscan_isolated_one_mission_per_image_call').pass, false);
});

test('Elise fallback (no provider answer) fails the turn check', () => {
  const verdict = evaluate({
    logs: parseActivationRows(ON_ROWS),
    ...OK_RESPONSES,
    elise: { ...OK_RESPONSES.elise, status: 'error' },
  });
  assert.equal(verdict.checks.find((c) => c.name === 'elise_turn_succeeded').pass, false);
});
