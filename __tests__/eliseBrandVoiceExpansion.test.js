'use strict';

// Build 35 expansion: pure brand-voice behavior + guarded Gemini wiring tests.
// Tests are intentionally offline: no keys, user records, provider calls or deploy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const backendRoot = path.join(root, 'supabase/functions/stylechat-generate');
const voiceSource = fs.readFileSync(path.join(backendRoot, 'eliseBrandVoice.ts'), 'utf8');
const configSource = fs.readFileSync(path.join(backendRoot, 'eliseConfig.ts'), 'utf8');
const handlerSource = fs.readFileSync(path.join(backendRoot, 'index.ts'), 'utf8');
const speechSource = fs.readFileSync(path.join(root, 'supabase/functions/stylist-speech/handler.ts'), 'utf8');

function loadVoiceModule() {
  // Transpile just the side-effect-free pure module; do not instantiate Edge Functions.
  const code = ts.transpileModule(voiceSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports }, {
    filename: 'eliseBrandVoice.ts',
  });
  return module.exports;
}

test('disabled global voice flag leaves existing Gemini system text byte-identical', () => {
  const { appendEliseBrandVoice } = loadVoiceModule();
  const before = 'Original system constraints\n\nApproved explanation instructions';
  assert.equal(appendEliseBrandVoice(before, false), before);
  assert.equal(appendEliseBrandVoice(before, undefined), before);
});

test('enabled brand voice adds versioned style guidance without replacing existing constraints', () => {
  const { appendEliseBrandVoice, ELISE_BRAND_VOICE_VERSION, ELISE_BRAND_VOICE_SYSTEM_BLOCK } = loadVoiceModule();
  assert.equal(ELISE_BRAND_VOICE_VERSION, 'elise-brand-voice-v1');
  const before = 'Existing permissions and action rules';
  const result = appendEliseBrandVoice(before, true);
  assert.ok(result.startsWith(before + '\n\n'));
  assert.ok(result.includes(ELISE_BRAND_VOICE_SYSTEM_BLOCK));
  assert.match(result, /verified product facts/);
  assert.match(result, /authorization/);
  assert.doesNotMatch(result, /Your name is Elise/);
});

test('global flag is default-off and prompt version changes only when activated', () => {
  assert.match(configSource, /brandVoiceV1: boolean/);
  assert.match(configSource, /parseBooleanEnv\(env, 'ELISE_BRAND_VOICE_V1_ENABLED', false\)/);
  assert.match(configSource, /brandVoiceV1\s*\? `\$\{ELISE_PROMPT_VERSION\}\+\$\{ELISE_BRAND_VOICE_VERSION\}`/);
  assert.match(configSource, /\s+brandVoiceV1,/);
});

test('conversational Gemini primary and retry paths receive the same prompt', () => {
  assert.match(handlerSource, /const baseSystemPrompt = appendEliseBrandVoice\(/);
  assert.match(handlerSource, /config\.flags\.brandVoiceV1/);
  assert.match(handlerSource, /buildStylistPersonaBlock\(stylistDisplayName\)/);
  assert.match(handlerSource, /buildGeminiBody\(systemTextWithAttachments, turns\)/);
  assert.match(handlerSource, /buildGeminiBody\(systemTextWithAttachments, buildRetryTurns\(turns\)\)/);
  assert.match(handlerSource, /system_instruction: \{ parts: \[\{ text: systemText \}\] \}/);
});

test('brand expansion leaves ElevenLabs speaking verified messages, not generating replies', () => {
  assert.match(speechSource, /getMessage\(body\.messageId, actor\.id\)/);
  assert.match(speechSource, /speechText = buildSpeechText\(message\.content\)/);
  assert.match(speechSource, /generateSpeech\(\{/);
  assert.doesNotMatch(speechSource, /appendEliseBrandVoice|ELISE_BRAND_VOICE/);
});
