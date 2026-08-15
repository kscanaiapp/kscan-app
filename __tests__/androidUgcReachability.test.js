'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ROOM_SURFACES = [
  'app/(public)/rooms/[token].tsx',
  'app/dressing-rooms/[id].tsx',
  'app/dressing-rooms/index.tsx',
  'components/rooms/RoomMessagesPanel.tsx',
];

/**
 * Every `Platform.OS === 'ios'` branch allowed inside a UGC surface, and why.
 * Anything else means an Android user cannot reach a shipped capability.
 */
const ALLOWED_IOS_BRANCHES = [
  { marker: 'behavior=', reason: 'KeyboardAvoidingView needs a different mode per platform' },
  { marker: 'buildRoomSharePayload', reason: 'the Share sheet takes url on iOS, message on Android' },
];

test('no shared-room or UGC surface is gated to iOS', () => {
  for (const file of ROOM_SURFACES) {
    const lines = read(file).split('\n');

    lines.forEach((line, index) => {
      if (!/Platform\.OS\s*===\s*'ios'/.test(line)) return;

      // Look back for the construct the branch belongs to, then forward past it.
      const window = lines.slice(Math.max(0, index - 6), index + 2).join('\n');
      const allowed = ALLOWED_IOS_BRANCHES.find(({ marker }) => window.includes(marker));

      assert.ok(
        allowed,
        `${file}:${index + 1} gates behaviour on iOS with no approved reason: ${line.trim()}`,
      );
    });
  }
});

test('the Android share payload still carries the HTTPS room link', () => {
  const source = read('app/dressing-rooms/[id].tsx');
  const builder = /const buildRoomSharePayload[\s\S]*?\n\};/.exec(source);

  assert.ok(builder, 'buildRoomSharePayload not found');
  // React Native's Share API ignores `url` on Android, so the link has to live in the
  // message or Android users share a room with no way to open it.
  assert.match(builder[0], /message = `Join my K Scan Dressing Room: \$\{shareUrl\}`/);
  assert.match(builder[0], /Platform\.OS === 'ios'/);
});

test('collaborator mode is available to the native Android client', () => {
  const source = read('app/(public)/rooms/[token].tsx');

  // The gate is web-versus-native, not iOS-versus-Android.
  assert.match(source, /collaboratorMode = mode === 'collaborator' && Platform\.OS !== 'web'/);
  assert.doesNotMatch(source, /Platform\.OS\s*!==\s*'android'/);
});

test('every shipped room capability flag is on in the production profile', () => {
  const production = JSON.parse(read('eas.json')).build.production.env;

  for (const flag of [
    'EXPO_PUBLIC_ROOM_CHAT_ENABLED',
    'EXPO_PUBLIC_DRESSING_ROOM_COLLABORATION_V1',
    'EXPO_PUBLIC_DRESSING_ROOM_MESSAGES_V1',
    'EXPO_PUBLIC_DRESSING_ROOM_REACTIONS_V1',
    'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1',
    'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_INTERACTIONS_V1',
  ]) {
    assert.equal(production[flag], 'true', `${flag} is not enabled for production`);
  }
});

test('Wear and cost-per-wear stay unreachable in the production profile', () => {
  const production = JSON.parse(read('eas.json')).build.production.env;
  const freeTier = Object.keys(production).filter((key) => key.includes('FREE_TIER'));

  assert.deepEqual(freeTier, [], 'a FREE_TIER flag reached the production profile');
  assert.match(read('constants/featureFlags.ts'), /^export const WEAR_TRACKING_ACTIVE = false;$/m);
});
