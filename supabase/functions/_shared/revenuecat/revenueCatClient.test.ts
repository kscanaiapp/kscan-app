import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  isBlockingRevenueCatCleanupStatus,
  isRevenueCatSyncEnabled,
  retireMirroredEntitlement,
  syncPromotionalEntitlement,
} from './revenueCatClient.ts';

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
    {
      REVENUECAT_SYNC_ENABLED: 'true',
      REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
      REVENUECAT_PROJECT_ID: 'proj_test_fixture',
    },
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

Deno.test('syncPromotionalEntitlement never reaches the network without a project id (V2 requires project scoping)', async () => {
  await withEnv(
    {
      REVENUECAT_SYNC_ENABLED: 'true',
      REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
      REVENUECAT_PROJECT_ID: undefined,
    },
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

// ── KPLUS-P2-001: retireMirroredEntitlement (RevenueCat mirror cleanup at account purge) ──
//
// Behavioral proof of the HTTP-status classification, idempotency, and
// actor-binding contracts is in __tests__/revenueCatCleanupClient.test.js,
// which runs under Node (via ts.transpileModule + a mocked Deno.env/fetch)
// since this repo's Node governed suite does not have a Deno binary
// available in every environment. The tests below cover the same env-gated
// short-circuits as syncPromotionalEntitlement's above -- the ones that
// never reach the network -- so this file's own `deno test` run (no network
// permission granted) still exercises the real Deno module directly.

Deno.test('retireMirroredEntitlement short-circuits to not_required when sync is disabled, without any network call', async () => {
  await withEnv({ REVENUECAT_SYNC_ENABLED: 'false' }, async () => {
    const outcome = await retireMirroredEntitlement({ appUserId: 'test-user' });
    assertEquals(outcome.status, 'not_required');
    assertEquals(outcome.ok, true);
  });
});

Deno.test('retireMirroredEntitlement never reaches the network without a secret key', async () => {
  await withEnv(
    { REVENUECAT_SYNC_ENABLED: 'true', REVENUECAT_SECRET_API_KEY: undefined },
    async () => {
      const outcome = await retireMirroredEntitlement({ appUserId: 'test-user' });
      assertEquals(outcome.status, 'failed_retryable');
      assertEquals(outcome.ok, false);
    },
  );
});

Deno.test('retireMirroredEntitlement never reaches the network without a project id', async () => {
  await withEnv(
    {
      REVENUECAT_SYNC_ENABLED: 'true',
      REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
      REVENUECAT_PROJECT_ID: undefined,
    },
    async () => {
      const outcome = await retireMirroredEntitlement({ appUserId: 'test-user' });
      assertEquals(outcome.status, 'failed_retryable');
      assertEquals(outcome.ok, false);
    },
  );
});

Deno.test('isBlockingRevenueCatCleanupStatus treats retired/already_retired/not_required as settled, everything else as blocking', () => {
  for (const settled of ['retired', 'already_retired', 'not_required']) {
    assertEquals(isBlockingRevenueCatCleanupStatus(settled), false);
  }
  for (const blocking of ['failed_retryable', 'failed_terminal', 'unknown']) {
    assertEquals(isBlockingRevenueCatCleanupStatus(blocking), true);
  }
});
