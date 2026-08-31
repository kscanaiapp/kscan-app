import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  attachWatchCapability,
  deriveWatchCapability,
  watchProviderForUrl,
} from './watchlistCapability.ts';

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prior[key] = Deno.env.get(key);
    Deno.env.set(key, vars[key]);
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prior[key] === undefined) Deno.env.delete(key);
      else Deno.env.set(key, prior[key] as string);
    }
  }
}

const FARFETCH_URL = 'https://www.farfetch.com/shopping/item-item-12345.aspx';
const KICKSCREW_URL = 'https://www.kickscrew.com/products/some-sneaker';
const SERPER_URL = 'https://www.somerandomretailer.com/product/123';

Deno.test('unsupported provider (Serper/Brave/Poshmark-shaped URL) is never watchable, regardless of env flags', () => {
  withEnv({ FARFETCH3_ENABLED: 'true', KICKSCREW_ENABLED: 'true' }, () => {
    const cap = deriveWatchCapability({ type: 'retail', productUrl: SERPER_URL });
    assertEquals(cap, 'unsupported');
  });
});

Deno.test('a "similar" (non-retail) result is never watchable, even on an otherwise-eligible URL', () => {
  withEnv({ FARFETCH3_ENABLED: 'true' }, () => {
    const cap = deriveWatchCapability({ type: 'similar', productUrl: FARFETCH_URL });
    assertEquals(cap, 'unsupported');
  });
});

Deno.test('Farfetch product URL is watchable only when FARFETCH3_ENABLED=true', () => {
  withEnv({ FARFETCH3_ENABLED: 'true' }, () => {
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: FARFETCH_URL }), 'refreshable_listing');
  });
  withEnv({ FARFETCH3_ENABLED: 'false' }, () => {
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: FARFETCH_URL }), 'unsupported');
  });
});

Deno.test('KicksCrew product URL is watchable only when KICKSCREW_ENABLED=true', () => {
  withEnv({ KICKSCREW_ENABLED: 'true' }, () => {
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: KICKSCREW_URL }), 'refreshable_listing');
  });
  withEnv({ KICKSCREW_ENABLED: 'false' }, () => {
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: KICKSCREW_URL }), 'unsupported');
  });
});

Deno.test('unsafe URLs (non-HTTPS, credentials, private hosts) are never watchable', () => {
  withEnv({ FARFETCH3_ENABLED: 'true', KICKSCREW_ENABLED: 'true' }, () => {
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: 'http://www.farfetch.com/item-item-1.aspx' }), 'unsupported');
    assertEquals(
      deriveWatchCapability({ type: 'retail', productUrl: 'https://user:pass@www.farfetch.com/item-item-1.aspx' }),
      'unsupported',
    );
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: 'https://127.0.0.1/item-item-1.aspx' }), 'unsupported');
    assertEquals(deriveWatchCapability({ type: 'retail', productUrl: undefined }), 'unsupported');
  });
});

Deno.test('a listing/search-page Farfetch URL (no -item-<digits>.aspx) is not watchable', () => {
  withEnv({ FARFETCH3_ENABLED: 'true' }, () => {
    assertEquals(
      deriveWatchCapability({ type: 'retail', productUrl: 'https://www.farfetch.com/shopping/items.aspx' }),
      'unsupported',
    );
  });
});

Deno.test('watchProviderForUrl returns the registry label only for an actually-eligible URL', () => {
  withEnv({ FARFETCH3_ENABLED: 'true', KICKSCREW_ENABLED: 'false' }, () => {
    assertEquals(watchProviderForUrl(FARFETCH_URL), 'farfetch');
    assertEquals(watchProviderForUrl(KICKSCREW_URL), null);
    assertEquals(watchProviderForUrl(SERPER_URL), null);
    assertEquals(watchProviderForUrl(undefined), null);
  });
});

Deno.test('attachWatchCapability is additive: same length, same order, same existing fields, one extra field', () => {
  withEnv({ FARFETCH3_ENABLED: 'true' }, () => {
    const input = [
      { id: 'a', title: 'A', source: 'Serper', type: 'retail' as const, productUrl: SERPER_URL, price: '$10' },
      { id: 'b', title: 'B', source: 'Farfetch', type: 'retail' as const, productUrl: FARFETCH_URL, price: '$20' },
    ];
    const out = attachWatchCapability(input);
    assertEquals(out.length, input.length);
    assertEquals(out[0].id, 'a');
    assertEquals(out[0].watchCapability, 'unsupported');
    assertEquals(out[1].id, 'b');
    assertEquals(out[1].watchCapability, 'refreshable_listing');
    // every original field survives untouched
    assertEquals(out[0].price, '$10');
    assertEquals(out[1].price, '$20');
  });
});

Deno.test('a forged client-supplied watchCapability is irrelevant — only server fields are read', () => {
  // Simulates a hostile client echoing 'refreshable_listing' on a listing
  // whose real productUrl/type make it ineligible. deriveWatchCapability
  // never reads a pre-existing `watchCapability` field at all.
  withEnv({ FARFETCH3_ENABLED: 'true' }, () => {
    const forged = { type: 'retail', productUrl: SERPER_URL, watchCapability: 'refreshable_listing' };
    assertEquals(deriveWatchCapability(forged), 'unsupported');
  });
});
