import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  decodeOfferCodeHmacSecret,
  digestOfferCode,
  normalizeOfferCodeForDigest,
  sanitizeOfferRedemptionResult,
} from './offerCodeContract.ts';

Deno.test('offer codes are canonicalized only on the server', () => {
  assertEquals(normalizeOfferCodeForDigest('  kscan-１２３  '), 'KSCAN-123');
});

Deno.test('the digest is deterministic and does not reveal the code', async () => {
  const secret = new Uint8Array(32).fill(7);
  const first = await digestOfferCode('KSCAN-123', secret);
  const retry = await digestOfferCode('  kscan-１２３ ', secret);
  assertEquals(first, retry);
  assertEquals(first.length, 64);
  assertEquals(first.includes('KSCAN'), false);
});

Deno.test('missing, malformed, and short secrets fail closed', async () => {
  for (const value of [null, '', 'not base64!', btoa('short')]) {
    await assertRejects(async () => decodeOfferCodeHmacSecret(value));
  }
});

Deno.test('unknown server results degrade to ERROR', () => {
  assertEquals(sanitizeOfferRedemptionResult('SUCCESS'), 'SUCCESS');
  assertEquals(sanitizeOfferRedemptionResult('HIGH_VALUE_CAMPAIGN'), 'ERROR');
});
