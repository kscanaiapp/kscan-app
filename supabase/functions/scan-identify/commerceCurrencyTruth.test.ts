import { assertEquals } from 'jsr:@std/assert@1';
import { buildCanonicalCommerce, parseOfferPrice } from './canonicalCommerce.ts';
import { normalizePrice } from './shoppingProvider.ts';

Deno.test('RP-110: a numeric provider price remains unlabelled without a currency', () => {
  assertEquals(normalizePrice(29.99), 29.99);

  const canonical = buildCanonicalCommerce([{
    id: 'unknown-currency',
    title: 'Leather Jacket',
    source: 'Retailer',
    price: 29.99,
    productUrl: 'https://retailer.example/jacket',
    type: 'retail',
  }]);

  assertEquals(canonical.products[0].offers[0].price, 29.99);
  assertEquals(canonical.products[0].offers[0].currency, null);
  assertEquals(canonical.products[0].lowestPriceValue, null);
});

Deno.test('RP-110: explicit known currencies survive the provider-to-canonical contract', () => {
  const canonical = buildCanonicalCommerce([
    {
      id: 'usd', title: 'USD Jacket', source: 'Retailer', price: 29.99, currency: ' usd ',
      productUrl: 'https://retailer.example/usd', type: 'retail',
    },
    {
      id: 'eur', title: 'EUR Jacket', source: 'Retailer', price: 29.99, currency: 'EUR',
      productUrl: 'https://retailer.example/eur', type: 'retail',
    },
    {
      id: 'gbp', title: 'GBP Jacket', source: 'Retailer', price: 29.99, currency: 'GBP',
      productUrl: 'https://retailer.example/gbp', type: 'retail',
    },
  ]);

  assertEquals(canonical.products.map((product) => product.offers[0].currency), ['USD', 'EUR', 'GBP']);
});

Deno.test('RP-110: symbols and malformed currency text never become trusted ISO currency', () => {
  assertEquals(parseOfferPrice('$29.99').currency, null);
  assertEquals(parseOfferPrice('£29.99').currency, null);
  assertEquals(parseOfferPrice('EUR 29.99').currency, 'EUR');

  const canonical = buildCanonicalCommerce([{
    id: 'malformed-currency',
    title: 'Jacket',
    source: 'Retailer',
    price: 29.99,
    currency: 'dollars',
    productUrl: 'https://retailer.example/malformed',
    type: 'retail',
  }]);
  assertEquals(canonical.products[0].offers[0].currency, null);
});

Deno.test('RP-110: lowest price is unavailable for mixed or unknown currencies', () => {
  const mixed = buildCanonicalCommerce([
    {
      id: 'usd', title: 'Same Jacket', source: 'A', price: 29.99, currency: 'USD',
      productUrl: 'https://a.example/jacket', type: 'retail',
    },
    {
      id: 'eur', title: 'Same Jacket', source: 'B', price: 27.99, currency: 'EUR',
      productUrl: 'https://b.example/jacket', type: 'retail',
    },
  ]);
  assertEquals(mixed.products[0].lowestPriceValue, null);
});
