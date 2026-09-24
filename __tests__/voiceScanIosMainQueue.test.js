'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Voice Scan iOS: the 15-second listening cap must actually be able to fire.
 *
 * KScanVoiceNativeModule.swift schedules the cap with Timer.scheduledTimer
 * inside startListening. A scheduled Timer attaches to the CURRENT thread's
 * run loop. ExpoModulesCore runs an AsyncFunction on its own GCD queue
 * ("expo.modules.AsyncFunctionQueue") unless the definition says
 * `.runOnQueue(.main)`, and GCD worker threads never run their run loop -- so
 * on iOS the cap never fired and the microphone stayed open until the user
 * tapped Stop or Cancel. The Android module already pins all five functions
 * to the main queue.
 *
 * Pinning to main also puts the JS-driven stop/cancel paths on the same
 * thread as the recognitionTask result handler (SFSpeechRecognizer delivers
 * on the main queue by default) and the resign-active observer, so the
 * session state is no longer touched from two threads at once.
 *
 * There is no Xcode on the CI runners that execute this suite, so this is a
 * structural contract over the Swift source; it cannot run the module.
 */

const MODULE_DIR = path.resolve(__dirname, '..', 'modules', 'kscan-voice-native');
const SWIFT_PATH = path.join(MODULE_DIR, 'ios', 'KScanVoiceNativeModule.swift');
const KOTLIN_PATH = path.join(
  MODULE_DIR, 'android', 'src', 'main', 'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt',
);

const FUNCTIONS = ['getCapabilities', 'requestPermissions', 'startListening', 'stopListening', 'cancelListening'];

/**
 * Splits the module definition at each AsyncFunction("name") declaration and
 * returns the names whose declaration is not followed by `pinnedCall` before
 * the next declaration (or the lifecycle hooks that close the list).
 */
function unpinnedFunctions(source, pinnedCall) {
  const declaration = /AsyncFunction\("([A-Za-z]+)"\)/g;
  const found = [...source.matchAll(declaration)];
  const lifecycle = source.search(/\bOnCreate\s*\{/);
  return found
    .filter((match, i) => {
      const end = i + 1 < found.length ? found[i + 1].index : (lifecycle === -1 ? source.length : lifecycle);
      return !source.slice(match.index, end).includes(pinnedCall);
    })
    .map((match) => match[1]);
}

test('iOS: all five Voice Scan functions are declared', () => {
  const swift = fs.readFileSync(SWIFT_PATH, 'utf8');
  const declared = [...swift.matchAll(/AsyncFunction\("([A-Za-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...FUNCTIONS].sort());
});

test('iOS: every Voice Scan function runs on the main queue', () => {
  const swift = fs.readFileSync(SWIFT_PATH, 'utf8');
  assert.deepEqual(
    unpinnedFunctions(swift, '.runOnQueue(.main)'),
    [],
    'an AsyncFunction without .runOnQueue(.main) runs on a GCD queue where the 15s cap Timer never fires',
  );
});

test('iOS: the cap Timer is scheduled only inside startListening', () => {
  const swift = fs.readFileSync(SWIFT_PATH, 'utf8');
  const timers = [...swift.matchAll(/Timer\.scheduledTimer\(/g)];
  assert.equal(timers.length, 1, 'exactly one scheduled Timer (the 15s cap)');

  const startListening = swift.indexOf('private func startListening(');
  const nextFunction = swift.indexOf('private func finishListening(');
  assert.ok(startListening !== -1 && nextFunction > startListening);
  assert.ok(
    timers[0].index > startListening && timers[0].index < nextFunction,
    'the cap Timer must be created in startListening, which the main-pinned AsyncFunction calls',
  );
});

test('parity: Android pins the same five functions to its main queue', () => {
  const kotlin = fs.readFileSync(KOTLIN_PATH, 'utf8');
  assert.deepEqual(unpinnedFunctions(kotlin.replace(/\bOnCreate\s*\{/g, 'OnCreate {'), '.runOnQueue(Queues.MAIN)'), []);
});

test('negative control: an unpinned startListening is detected', () => {
  const swift = fs.readFileSync(SWIFT_PATH, 'utf8');
  const start = swift.indexOf('AsyncFunction("startListening")');
  const pin = swift.indexOf('.runOnQueue(.main)', start);
  assert.ok(start !== -1 && pin !== -1);
  const mutant = swift.slice(0, pin) + swift.slice(pin + '.runOnQueue(.main)'.length);

  assert.deepEqual(unpinnedFunctions(mutant, '.runOnQueue(.main)'), ['startListening']);
});
