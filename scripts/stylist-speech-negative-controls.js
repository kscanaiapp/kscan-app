#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourceDir = 'supabase/functions/stylist-speech';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-speech-mutants-'));
const files = [
  'services/avatarSpeech.ts',
  'stores/avatarSpeechStore.ts',
  '__tests__/stylistVoiceReliability.test.js',
  '__tests__/stylistSpeechClientLifecycle.test.js',
  ...fs.readdirSync(path.join(root, sourceDir)).filter((name) => name.endsWith('.ts'))
    .map((name) => `${sourceDir}/${name}`),
];
for (const file of files) {
  const target = path.join(sandbox, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
const service = 'services/avatarSpeech.ts';
const provider = `${sourceDir}/elevenLabsClient.ts`;
const handler = `${sourceDir}/handler.ts`;
const controls = [
  { id: 'NC-SP-01', file: service,
    from: "if ((payload.trigger ?? 'auto') === 'auto' && spokenKeys.has(key)) return;", to: '',
    node: 'stylistVoiceReliability', filter: 'an explicit retry passes the success record' },
  { id: 'NC-SP-02', file: service, from: 'player?.stop();', to: '',
    node: 'stylistSpeechClientLifecycle', filter: 'a newer utterance stops' },
  { id: 'NC-SP-03', file: service, from: 'return generation === value;', to: 'return true;',
    node: 'stylistSpeechClientLifecycle', filter: 'account switch discards' },
  { id: 'NC-SP-04', file: provider, from: '() => controller.abort(),', to: '() => {},',
    deno: 'elevenLabsClient', filter: 'aborts a provider request', timeoutMutant: true },
  { id: 'NC-SP-05', file: handler,
    from: 'if (keys.some((key) => !MESSAGE_REQUEST_KEYS.has(key))) {', to: 'if (false) {',
    deno: 'handler', filter: 'rejects malformed references and all client-supplied speech material' },
  { id: 'NC-SP-06', file: handler,
    from: "const MESSAGE_REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId']);",
    to: "const MESSAGE_REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId', 'text']);",
    deno: 'handler', filter: 'rejects malformed references and all client-supplied speech material' },
  { id: 'NC-SP-07', file: provider, from: 'if (body.oversized) {', to: 'if (false) {',
    deno: 'elevenLabsClient', filter: 'rejects oversized provider responses' },
  { id: 'NC-SP-08', file: provider, from: 'if (!validateBase64(parsed.audio_base64)) {', to: 'if (false) {',
    deno: 'elevenLabsClient', filter: 'rejects malformed JSON and invalid audio' },
];

function run(control, timeout = 30_000) {
  const args = control.node
    ? ['--test', `--test-name-pattern=${control.filter}`, `__tests__/${control.node}.test.js`]
    : ['test', '--no-config', '--no-lock', '--no-check', '--node-modules-dir=none',
      '--allow-read', '--allow-env', '--filter', control.filter, `${sourceDir}/${control.deno}.test.ts`];
  return spawnSync(control.node ? process.execPath : 'deno', args, {
    cwd: sandbox, encoding: 'utf8', timeout,
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  });
}

const results = [];
try {
  for (const control of controls) {
    const file = path.join(sandbox, control.file);
    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(control.from)) throw new Error(`${control.id}: mutation target absent`);
    const before = run(control);
    if (before.status !== 0) throw new Error(`${control.id}: baseline not green\n${before.stdout}\n${before.stderr}`);
    let mutant;
    try {
      fs.writeFileSync(file, original.replace(control.from, control.to));
      mutant = run(control, control.timeoutMutant ? 10_000 : 30_000);
    } finally {
      fs.writeFileSync(file, original);
    }
    const output = `${mutant.stdout || ''}\n${mutant.stderr || ''}`;
    const red = control.timeoutMutant
      ? output.includes(control.filter) && (/ETIMEDOUT/.test(mutant.error?.code || '') || /FAILED|cancelled|pending/i.test(output))
      : mutant.status === 1 && /AssertionError|ERR_ASSERTION/.test(output);
    if (!red) throw new Error(`${control.id}: mutant did not fail its invariant\n${output}`);
    const after = run(control);
    if (after.status !== 0) throw new Error(`${control.id}: restored code not green\n${after.stdout}\n${after.stderr}`);
    results.push({ id: control.id, before: 'GREEN', mutant: 'RED', restored: 'GREEN' });
    console.log(JSON.stringify(results[results.length - 1]));
  }
  for (const file of files) {
    if (!fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(sandbox, file)))) {
      throw new Error(`Source changed or mutant not restored: ${file}`);
    }
  }
  console.log(JSON.stringify({ negativeControls: results.length, sourceUntouched: true }));
} finally {
  // Only the exact directory allocated by mkdtemp for this invocation is removed.
  fs.rmSync(sandbox, { recursive: true, force: true });
}
