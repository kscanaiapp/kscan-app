import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { isRevenueCatSyncEnabled, syncPromotionalEntitlement } from './revenueCatClient.ts';

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = Deno.env.get(key);
    if (vars[key] === undefined) Deno.env.delete(key);
    else Deno.env.set(key, vars[key] as string);
  }
  return (async () => {
    try {
      await fn();
    } finally {
      for (const key of Object.keys(previous)) {
        if (previous[key] === undefined) Deno.env.delete(key);
        else Deno.env.set(key, previous[key] as string);
      }
    }
  })();
}

Deno.test('isRevenueCatSyncEnabled fails closed on anything but the literal string "true"', async () => {
  await withEnv({ REVENUECAT_SYNC_ENABLED: undefined }, () => {
    assertEquals(isRevenueCatSyncEnabled(), false);
  });
  await withEnv({ REVENUECAT_SYNC_ENABLED: 'false' }, () => {
    assertEquals(isRevenueCatSyncEnabled(), false);
  });
  await withEnv({ REVENUECAT_SYNC_ENABLED: 'TRUE' }, () => {
    // Case-insensitive match is intentional (env vars are often set via
    // platform UIs that don't preserve case), unlike the client feature-flag
    // convention which requires exact lowercase 'true'.
    assertEquals(isRevenueCatSyncEnabled(), true);
  });
  await withEnv({ REVENUECAT_SYNC_ENABLED: 'true' }, () => {
    assertEquals(isRevenueCatSyncEnabled(), true);
  });
});

Deno.test('syncPromotionalEntitlement short-circuits to not_required when sync is disabled', async () => {
  await withEnv({ REVENUECAT_SYNC_ENABLED: 'false' }, async () => {
    const outcome = await syncPromotionalEntitlement({
      appUserId: 'test-user',
      expiresAt: new Date().toISOString(),
    });
    assertEquals(outcome.status, 'not_required');
    assertEquals(outcome.ok, false);
  });
});

Deno.test('syncPromotionalEntitlement never reaches the network without a secret key', async () => {
  await withEnv(
    { REVENUECAT_SYNC_ENABLED: 'true', REVENUECAT_SECRET_API_KEY: undefined },
    async () => {
      const outcome = await syncPromotionalEntitlement({
        appUserId: 'test-user',
        expiresAt: new Date().toISOString(),
      });
      assertEquals(outcome.status, 'failed_retryable');
      assertEquals(outcome.ok, false);
    },
  );
});

Deno.test('syncPromotionalEntitlement rejects an unparseable expiresAt before any network call', async () => {
  await withEnv(
    { REVENUECAT_SYNC_ENABLED: 'true', REVENUECAT_SECRET_API_KEY: 'sk_test_fixture' },
    async () => {
      const outcome = await syncPromotionalEntitlement({
        appUserId: 'test-user',
        expiresAt: 'not-a-date',
      });
      assertEquals(outcome.status, 'failed_terminal');
      assertEquals(outcome.ok, false);
    },
  );
});
