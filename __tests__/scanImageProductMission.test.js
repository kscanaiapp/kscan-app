'use strict';

// Build 35 Scanner image-mission test: deterministic offline controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'supabase/functions/scan-identify');
const source = fs.readFileSync(path.join(dir, 'scanImageProductMission.ts'), 'utf8');
const handler = fs.readFileSync(path.join(dir, 'index.ts'), 'utf8');
const brandEvidence = fs.readFileSync(path.join(dir, 'brandEvidence.ts'), 'utf8');
const router = fs.readFileSync(path.join(dir, 'scanCommerceRouter.ts'), 'utf8');

const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObj = { exports: {} };
vm.runInNewContext(output, { module: moduleObj, exports: moduleObj.exports }, { filename: 'scanImageProductMission.ts' });
const mission = moduleObj.exports;

test('image mission is default-off and OFF yields no change to request body', () => {
  assert.equal(mission.isScanImageProductMissionEnabled(() => undefined), false);
  assert.equal(mission.isScanImageProductMissionEnabled(() => 'false'), false);
  assert.equal(mission.isScanImageProductMissionEnabled(() => 'true'), true);
  assert.equal(mission.buildScanImageProductMission(false, 'scanner_camera', 'legacy_single_item'), null);
});

test('camera and gallery routes receive distinct mission context without ownership claims', () => {
  const cam = mission.buildScanImageProductMission(true, 'scanner_camera', 'legacy_single_item');
  const gallery = mission.buildScanImageProductMission(true, 'scanner_gallery', 'legacy_single_item');
  assert.match(cam, /live camera scan/i);
  assert.match(gallery, /gallery upload or screenshot/i);
  assert.match(gallery, /not proof of purchase or ownership/i);
  assert.match(cam, /EXACT product identity/);
  assert.match(cam, /clearly visible logo/i);
  assert.match(cam, /wordmark/i);
  assert.match(cam, /verified business evidence/i);
  assert.match(cam, /Black-owned/i);
  assert.match(cam, /exact SKU/i);
  assert.ok(cam.length < 4800);
});

test('selected garment and multiple garment workflows retain their distinct task', () => {
  const multi = mission.buildScanImageProductMission(true, 'scanner_gallery', 'multi_item_detection');
  const selected = mission.buildScanImageProductMission(true, 'elise_gallery', 'selected_item');
  assert.match(multi, /multi-item detection only/i);
  assert.match(multi, /first pass/i);
  assert.match(selected, /authorized candidate and its bounds/i);
  assert.match(selected, /direct Elise gallery image/i);
  assert.match(selected, /objective attributes for the stylist handoff/i);
});

test('unknown caller source is not falsely attributed to camera or gallery', () => {
  assert.equal(mission.classifyImageMissionSource('  SCANNER_CAMERA  '), 'scanner_camera');
  assert.equal(mission.classifyImageMissionSource('external_fake_camera'), 'unknown');
  assert.equal(mission.classifyImageMissionSource(undefined), 'unknown');
  const unknown = mission.buildScanImageProductMission(true, 'external_fake_camera', 'legacy_single_item');
  assert.match(unknown, /general image analysis/i);
});

test('system instruction is image-only and the TextScan branch remains untouched', () => {
  assert.match(handler, /const imageMission = mode === 'image'/);
  assert.match(handler, /isScanImageProductMissionEnabled\(\(key\) => Deno\.env\.get\(key\)\)/);
  assert.match(handler, /\.\.\.\(imageMission \? \{ system_instruction: \{ parts: \[\{ text: imageMission \}\] \} \} : \{\}\)/);
  assert.match(handler, /const geminiBody = mode === 'text'/);
  assert.match(handler, /responseMimeType: 'application\/json'/);
  assert.match(handler, /buildSelectedItemPrompt\(selectedCandidate, commerceIdentityEnabled\)/);
  assert.match(handler, /buildRoutedIdentifyPrompt\(prompt, categoryRoute\)/);
});

test('existing scanner brand evidence continues recognizing distinct visible logos', () => {
  assert.match(brandEvidence, /A single sufficiently distinctive, confidently classified logo can identify a brand without readable text/);
  assert.match(brandEvidence, /Logo evidence establishes brand only, not an exact product/);
  assert.match(brandEvidence, /brandVerified: evidence\.verified/);
  assert.match(router, /retailer-neutral/i);
});
