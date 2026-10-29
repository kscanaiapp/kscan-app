'use strict';

// Build 35 scanner image mission: deterministic, no provider calls or user data.
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

const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObj = { exports: {} };
vm.runInNewContext(code, { module: moduleObj, exports: moduleObj.exports }, {
  filename: 'scanImageProductMission.ts',
});
const mission = moduleObj.exports;

test('flag is default-off and disabled mission preserves exact legacy provider payload', () => {
  assert.equal(mission.isScanImageProductMissionEnabled(() => undefined), false);
  assert.equal(mission.isScanImageProductMissionEnabled(() => 'false'), false);
  assert.equal(mission.isScanImageProductMissionEnabled(() => 'true'), true);
  assert.equal(mission.buildScanImageProductMission(false, 'legacy_single_item'), null);
});

test('one uniform image system mission prioritizes exact item, visible logos, and inclusive alternatives', () => {
  const text = mission.buildScanImageProductMission(true, 'legacy_single_item');
  assert.match(text, /EXACT ORIGINAL ITEM FIRST/);
  assert.match(text, /clearly visible[\s\S]*logos/);
  assert.match(text, /wordmarks/);
  assert.match(text, /specific product or model-family hypothesis/);
  assert.match(text, /NOT proof of a specific/);
  assert.match(text, /SIMILAR MATCHES NEXT/);
  assert.match(text, /Black-owned/);
  assert.match(text, /separately sourced, reliable business evidence/);
  assert.match(text, /STRICT JSON/);
  assert.ok(text.length < 6000);
});

test('existing request modes keep task-specific selected-item and collection rules', () => {
  const selected = mission.buildScanImageProductMission(true, 'selected_item');
  const multi = mission.buildScanImageProductMission(true, 'multi_item_detection');
  assert.match(selected, /previously authorized selected garment and its bounds/i);
  assert.match(multi, /Detect distinct visible fashion candidates only/i);
  assert.doesNotMatch(multi, /never switch to a larger or more recognizable item/i);
});

test('mission contains no per-entry-path conditionals or source-provenance assumptions', () => {
  assert.doesNotMatch(source, /case\s+['"](?:scanner|elise|closet)_/);
  assert.doesNotMatch(source, /entryPath\s*===/);
  assert.doesNotMatch(source, /classifyImageMissionSource/);
  assert.match(source, /Camera, gallery, Elise-photo and Closet-photo entry points/);
});

test('system instruction attaches only to image mode; TextScan remains unchanged', () => {
  assert.match(handler, /const imageMission = mode === 'image'/);
  assert.match(handler, /isScanImageProductMissionEnabled\(\(key\) => Deno\.env\.get\(key\)\)/);
  assert.match(handler, /\.\.\.\(imageMission \? \{ system_instruction: \{ parts: \[\{ text: imageMission \}\] \} \} : \{\}\)/);
  assert.match(handler, /const geminiBody = mode === 'text'/);
  assert.match(handler, /responseMimeType: 'application\/json'/);
  assert.match(handler, /buildSelectedItemPrompt\(selectedCandidate, commerceIdentityEnabled\)/);
});

test('pre-existing scanner brand classification still recognizes distinctive visible logos', () => {
  assert.match(brandEvidence, /A single sufficiently distinctive, confidently classified logo can identify a brand without readable text/);
  assert.match(brandEvidence, /Logo evidence establishes brand only, not an exact product/);
  assert.match(router, /retailer-neutral/i);
});
