'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateOffer, validateCorpus } = require('./identitySchema');

function baseCorpus() {
  return {
    corpusId: 'test-corpus',
    generatorVersion: 'cpil-generator-v1',
    seed: 'test-seed',
    corpusTier: 'SYNTHETIC',
    groundTruthSource: 'synthetic_generator_construction',
    offers: [{ offerId: 'a', retailer: 'X' }, { offerId: 'b', retailer: 'Y' }],
    canonicalStyles: [],
    cases: [],
    pairOverrides: [],
  };
}

// spec section 43#2: schema validation.
test('SCHEMA: a well-formed offer validates', () => {
  const { valid, errors } = validateOffer({ offerId: 'a', retailer: 'Nordstrom' });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('SCHEMA: an offer missing offerId is rejected', () => {
  const { valid, errors } = validateOffer({ retailer: 'Nordstrom' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('offerId')));
});

test('SCHEMA: an invalid sellerType is rejected', () => {
  const { valid } = validateOffer({ offerId: 'a', retailer: 'X', sellerType: 'not_a_real_type' });
  assert.equal(valid, false);
});

test('SCHEMA: a well-formed corpus validates', () => {
  const { valid, errors } = validateCorpus(baseCorpus());
  assert.equal(valid, true, JSON.stringify(errors));
});

// spec Addendum A.5#29: duplicate fixture IDs fail; missing provenance fails.
test('SCHEMA: duplicate offerId across the corpus fails validation', () => {
  const corpus = baseCorpus();
  corpus.offers.push({ offerId: 'a', retailer: 'Z' }); // duplicate of the first offer's id
  const { valid, errors } = validateCorpus(corpus);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /duplicate offerId/.test(e)));
});

test('SCHEMA: missing generatorVersion (provenance) fails corpus validation', () => {
  const corpus = baseCorpus();
  delete corpus.generatorVersion;
  const { valid, errors } = validateCorpus(corpus);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /generatorVersion/.test(e)));
});

test('SCHEMA: missing seed (determinism provenance) fails corpus validation', () => {
  const corpus = baseCorpus();
  delete corpus.seed;
  const { valid, errors } = validateCorpus(corpus);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /seed/.test(e)));
});

test('SCHEMA: an unrecognized corpusTier fails validation', () => {
  const corpus = baseCorpus();
  corpus.corpusTier = 'MADE_UP_TIER';
  const { valid } = validateCorpus(corpus);
  assert.equal(valid, false);
});

test('SCHEMA: a SYNTHETIC corpus claiming a non-synthetic groundTruthSource fails validation', () => {
  const corpus = baseCorpus();
  corpus.groundTruthSource = 'owner_annotation';
  const { valid, errors } = validateCorpus(corpus);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /groundTruthSource/.test(e)));
});

// Addendum A.5#28: privacy guard fires on root AND nested prohibited
// fields; data-URI and base64 payloads; token-shaped fields. Fail, never redact.
test('SCHEMA: an offer carrying a root-level prohibited field (user_id) fails validation, not silently stripped', () => {
  const offer = { offerId: 'a', retailer: 'X', user_id: 'abc123' };
  const { valid, errors } = validateOffer(offer);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
  assert.equal(offer.user_id, 'abc123', 'the field must still be present on the input object - validation rejects, it does not mutate/redact');
});

test('SCHEMA: a NESTED prohibited field inside an offer fails validation', () => {
  const offer = { offerId: 'a', retailer: 'X', constructionDetails: { auth_token: 'abc' } };
  const { valid, errors } = validateOffer(offer);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
});

test('SCHEMA: a data-URI base64 media payload anywhere in an offer fails validation', () => {
  const offer = { offerId: 'a', retailer: 'X', imageUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' };
  const { valid, errors } = validateOffer(offer);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
});

test('SCHEMA: a token-shaped field (JWT-shaped string) fails validation regardless of key name', () => {
  const offer = { offerId: 'a', retailer: 'X', title: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' };
  const { valid, errors } = validateOffer(offer);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
});

test('SCHEMA: a corpus carrying a privacy violation anywhere in its tree fails validation', () => {
  const corpus = baseCorpus();
  corpus.offers[0] = { ...corpus.offers[0], device_id: 'device-abc' };
  const { valid, errors } = validateCorpus(corpus);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
});
