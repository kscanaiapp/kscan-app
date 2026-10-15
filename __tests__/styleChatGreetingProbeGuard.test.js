const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('live greeting probe rejects Production, ambiguous fixtures and unconfirmed cleanup before network traffic', async () => {
  const { verifyGreetingConcurrency } = await import(pathToFileURL(path.resolve(__dirname,
    '../scripts/style-chat/verify-greeting-concurrency.mjs')).href);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('network must not run'); };
  const fixture = { stagingUrl: 'https://yzqjvdfgefveprobvvyw.supabase.co', publishableKey: 'synthetic-public',
    serviceRoleKey: 'synthetic-service', accessTokens: ['synthetic-one', 'synthetic-two'],
    expectedActorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedSessionId: '11111111-1111-4111-8111-111111111111', confirmPurposeCreatedEmptySession: true };
  try {
    for (const override of [
      { stagingUrl: 'https://wyyuqfdxucjksghsmhry.supabase.co' },
      { stagingUrl: 'not-a-url' },
      { stagingUrl: 'https://unexpected.invalid' },
      { stagingUrl: `${fixture.stagingUrl}:444` },
      { stagingUrl: `${fixture.stagingUrl}?redirect=unexpected` },
      { stagingUrl: `${fixture.stagingUrl}#unexpected` },
      { confirmPurposeCreatedEmptySession: false },
      { expectedActorId: '' },
      { expectedSessionId: '' },
      { accessTokens: ['same', 'same'] },
      { cleanupPurposeCreatedSessionId: '22222222-2222-4222-8222-222222222222' },
    ]) {
      await assert.rejects(verifyGreetingConcurrency({ ...fixture, ...override }), /Greeting probe:/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
