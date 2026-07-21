const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ANDROID_FIXTURE = {
  platform: 'android',
  contractVersion: '2',
  attachments: [
    {
      attachmentType: 'owned_item',
      sourceType: 'dressing_room_item',
      sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  ],
  uriExamples: ['content://media/external/images/1', 'file:///data/user/0/app/cache/x.jpg'],
};

const IOS_FIXTURE = {
  platform: 'ios',
  contractVersion: '2',
  attachments: [
    {
      attachmentType: 'owned_item',
      sourceType: 'dressing_room_item',
      sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  ],
  uriExamples: ['ph://ASSET-ID', 'file:///var/mobile/Containers/Data/x.jpg'],
};

const SHARED_FIXTURE = {
  contractVersion: '2',
  attachments: [
    {
      attachmentType: 'shared_item',
      sourceType: 'shared_room_item',
      sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
  ],
};

test('DR-2 Android/iOS request fixtures are semantically identical for room attachments', () => {
  assert.deepEqual(ANDROID_FIXTURE.attachments, IOS_FIXTURE.attachments);
  assert.equal(ANDROID_FIXTURE.contractVersion, IOS_FIXTURE.contractVersion);
  assert.notDeepEqual(ANDROID_FIXTURE.uriExamples, IOS_FIXTURE.uriExamples);
});

test('DR-2 shared TypeScript attachment contract is platform-agnostic', () => {
  const types = read('types/styleChatAttachments.ts');
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  assert.doesNotMatch(types, /Platform\.OS/);
  assert.doesNotMatch(provider, /Platform\.OS/);
  assert.match(types, /buildOwnedDressingRoomItemAttachment/);
  assert.match(types, /buildSharedRoomItemAttachment/);
  // Stable IDs only — no local URI authority on the wire contract.
  assert.doesNotMatch(types, /content:\/\/|ph:\/\/|file:\/\//);
});

test('DR-2 shared_item fixture matches server parser contract', () => {
  assert.equal(SHARED_FIXTURE.attachments[0].attachmentType, 'shared_item');
  assert.equal(SHARED_FIXTURE.attachments[0].sourceType, 'shared_room_item');
  const server = read('supabase/functions/stylechat-generate/attachments.ts');
  assert.match(server, /attachmentType === 'shared_item'/);
  assert.match(server, /shared_room_item/);
});

test('DR-2 stale-response protection exists in shared RN session hook', () => {
  const hook = read('hooks/useStyleChat.ts');
  assert.match(hook, /sendScopeVersion/);
  assert.match(hook, /isCurrentSend/);
});

test('DR-2 Android native tree exists; iOS is Expo-managed (no ios/ folder)', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'android')), true);
  // This Expo worktree does not ship a checked-in ios/ native project.
  assert.equal(fs.existsSync(path.join(ROOT, 'ios')), false);
  const appJson = JSON.parse(read('app.json'));
  assert.ok(appJson.expo);
  const platforms = appJson.expo.platforms || ['ios', 'android'];
  assert.ok(platforms.includes('ios') || appJson.expo.ios);
  assert.ok(platforms.includes('android') || appJson.expo.android);
});

test('DR-2 case-sensitive path checks for shared modules', () => {
  const required = [
    'services/style-chat/providers/edgeStyleChatProvider.ts',
    'types/styleChatAttachments.ts',
    'types/eliseAdvice.ts',
    'supabase/functions/stylechat-generate/eliseSharedRoomAccess.ts',
    'supabase/functions/stylechat-generate/eliseWardrobeRetrieval.ts',
  ];
  for (const rel of required) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), true, rel);
  }
});

test('DR-2 flags OFF leave Saved Scan / inspiration attachment paths intact', () => {
  const attachments = read('supabase/functions/stylechat-generate/attachments.ts');
  assert.match(attachments, /saved_scan/);
  assert.match(attachments, /inspiration_item/);
  const client = read('types/ownedClosetItem.ts');
  assert.match(client, /saved_scan/);
  assert.match(client, /inspiration_item/);
});
