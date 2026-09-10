/**
 * Commerce V2 commerce-exit contract (Build 35 §28-31, §82-83).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openCommerceOffer, recordCommerceExitEvent } = require('../../services/commerce/commerceExit.ts');
const { getOfferCase } = require('../fixtures/commerce/offers.js');

test('opens the exact safe offer URL and returns true', async () => {
  const opened = [];
  const ok = await openCommerceOffer(
    getOfferCase('retail_farfetch_declared').offer,
    'product_shelf',
    async (url) => opened.push(url),
  );
  assert.equal(ok, true);
  assert.deepEqual(opened, ['https://www.farfetch.com/shopping/women/levis-denim-jacket-item-1.aspx']);
});

test('never calls openUrl for an offer with no safe destination', async () => {
  let called = false;
  const ok = await openCommerceOffer(
    getOfferCase('unknown_retailer_no_url').offer,
    'product_shelf',
    async () => {
      called = true;
    },
  );
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('never calls openUrl for an unsafe (credentialed) destination', async () => {
  let called = false;
  const ok = await openCommerceOffer(
    { productUrl: 'https://user:pass@www.farfetch.com/shopping/x-item-1.aspx' },
    'product_shelf',
    async () => {
      called = true;
    },
  );
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('NEGATIVE CONTROL §82 (Shop identity): opening offer A never opens offer B\'s URL', async () => {
  const offerA = getOfferCase('same_product_offer_farfetch').offer;
  const offerB = getOfferCase('same_product_offer_poshmark').offer;
  const opened = [];
  await openCommerceOffer(offerA, 'purchase_options_panel', async (url) => opened.push(url));
  assert.deepEqual(opened, [offerA.productUrl]);
  assert.notEqual(opened[0], offerB.productUrl);
});

test('the URL handed to openUrl is byte-identical to the offer\'s own URL -- nothing stripped, nothing added (Decision Memo 2)', async () => {
  const offer = {
    productUrl: 'https://www.farfetch.com/shopping/x-item-1.aspx?utm_source=newsletter&pid=abc123',
  };
  const opened = [];
  await openCommerceOffer(offer, 'product_shelf', async (url) => opened.push(url));
  assert.deepEqual(opened, [offer.productUrl]);
});

test('returns false, does not throw, when openUrl itself rejects', async () => {
  const ok = await openCommerceOffer(
    getOfferCase('retail_farfetch_declared').offer,
    'product_shelf',
    async () => {
      throw new Error('no handler installed');
    },
  );
  assert.equal(ok, false);
});

test('a persisted-data surface can supply the stricter persisted-URL safety gate instead of the live one', async () => {
  const { normalizePersistedCommerceUrl } = require('../../services/dressingRoomCommerce.ts');
  // access_token is rejected by normalizePersistedCommerceUrl but NOT by
  // isSafeCommerceUrl (the live-URL gate) -- proves the override is really
  // applied, not silently ignored.
  const unsafeForPersisted = 'https://example.com/p?access_token=leaked-secret';
  let called = false;
  const okDefault = await openCommerceOffer({ productUrl: unsafeForPersisted }, 'watchlist_detail', async () => {
    called = true;
  });
  assert.equal(okDefault, true, 'the default live gate does not reject this URL');
  assert.equal(called, true);

  called = false;
  const okStrict = await openCommerceOffer(
    { productUrl: unsafeForPersisted },
    'watchlist_detail',
    async () => {
      called = true;
    },
    { validate: normalizePersistedCommerceUrl },
  );
  assert.equal(okStrict, false, 'the persisted gate must reject a credential-shaped param');
  assert.equal(called, false);
});

test('recordCommerceExitEvent is a documented no-op today (Decision Memo 1) and never throws', () => {
  assert.doesNotThrow(() => {
    recordCommerceExitEvent({
      action: 'shop',
      retailerKey: 'farfetch',
      commerceType: 'retail',
      sourceAuthority: 'declared',
      surface: 'product_shelf',
    });
  });
});
