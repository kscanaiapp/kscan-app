import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  assertJsonContentType,
  DEFAULT_MAX_BODY_BYTES,
  readBodyWithLimit,
  readJsonBody,
  validateRequestBody,
  type RequestSchema,
} from './validation.ts';

Deno.test('assertJsonContentType accepts application/json and rejects others', () => {
  assertEquals(assertJsonContentType(new Request('https://x.test', { headers: { 'Content-Type': 'application/json' } })), true);
  assertEquals(assertJsonContentType(new Request('https://x.test', { headers: { 'Content-Type': 'application/json; charset=utf-8' } })), true);
  assertEquals(assertJsonContentType(new Request('https://x.test', { headers: { 'Content-Type': 'text/plain' } })), false);
  assertEquals(assertJsonContentType(new Request('https://x.test')), false);
});

Deno.test('readBodyWithLimit rejects a missing body', async () => {
  const req = new Request('https://x.test', { method: 'GET' });
  const result = await readBodyWithLimit(req, 100);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'missing_body');
});

Deno.test('readBodyWithLimit rejects an oversized payload without buffering it fully', async () => {
  const oversized = 'x'.repeat(1000);
  const req = new Request('https://x.test', { method: 'POST', body: oversized });
  const result = await readBodyWithLimit(req, 100);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'too_large');
});

Deno.test('readBodyWithLimit accepts a payload within the limit', async () => {
  const req = new Request('https://x.test', { method: 'POST', body: 'hello world' });
  const result = await readBodyWithLimit(req, 100);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.raw, 'hello world');
});

Deno.test('readJsonBody rejects malformed JSON', async () => {
  const req = new Request('https://x.test', { method: 'POST', body: '{not json' });
  const result = await readJsonBody(req, DEFAULT_MAX_BODY_BYTES);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'malformed_json');
});

Deno.test('readJsonBody parses valid JSON', async () => {
  const req = new Request('https://x.test', { method: 'POST', body: JSON.stringify({ a: 1 }) });
  const result = await readJsonBody(req, DEFAULT_MAX_BODY_BYTES);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, { a: 1 });
});

const messageSchema: RequestSchema = {
  fields: {
    sessionId: { type: 'uuid', required: true },
    message: { type: 'string', required: true, minLength: 1, maxLength: 500 },
  },
};

Deno.test('validateRequestBody rejects missing required fields', () => {
  const result = validateRequestBody({}, messageSchema);
  assertEquals(result.ok, false);
});

Deno.test('validateRequestBody rejects unsupported fields by default', () => {
  const result = validateRequestBody(
    { sessionId: '11111111-2222-4333-8444-555555555555', message: 'hi', extra: 'nope' },
    messageSchema,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.issues.some((i) => i.includes('extra')), true);
});

Deno.test('validateRequestBody rejects excessive string length', () => {
  const result = validateRequestBody(
    { sessionId: '11111111-2222-4333-8444-555555555555', message: 'x'.repeat(501) },
    messageSchema,
  );
  assertEquals(result.ok, false);
});

Deno.test('validateRequestBody rejects excessive array length', () => {
  const schema: RequestSchema = { fields: { items: { type: 'array', maxItems: 3 } } };
  const result = validateRequestBody({ items: [1, 2, 3, 4] }, schema);
  assertEquals(result.ok, false);
});

Deno.test('validateRequestBody rejects an invalid enum value', () => {
  const schema: RequestSchema = { fields: { category: { type: 'string', enum: ['a', 'b'] } } };
  const result = validateRequestBody({ category: 'c' }, schema);
  assertEquals(result.ok, false);
});

Deno.test('validateRequestBody rejects a non-https url', () => {
  const schema: RequestSchema = { fields: { imageUrl: { type: 'url' } } };
  const result = validateRequestBody({ imageUrl: 'ftp://example.com/x.png' }, schema);
  assertEquals(result.ok, false);
});

Deno.test('validateRequestBody accepts a well-formed https url', () => {
  const schema: RequestSchema = { fields: { imageUrl: { type: 'url' } } };
  const result = validateRequestBody({ imageUrl: 'https://example.com/x.png' }, schema);
  assertEquals(result.ok, true);
});

Deno.test('validateRequestBody rejects a numeric value out of range', () => {
  const schema: RequestSchema = { fields: { budget: { type: 'number', min: 0, max: 1000 } } };
  assertEquals(validateRequestBody({ budget: -5 }, schema).ok, false);
  assertEquals(validateRequestBody({ budget: 1001 }, schema).ok, false);
  assertEquals(validateRequestBody({ budget: 500 }, schema).ok, true);
});

Deno.test('validateRequestBody accepts a valid message payload', () => {
  const result = validateRequestBody(
    { sessionId: '11111111-2222-4333-8444-555555555555', message: 'What goes with navy?' },
    messageSchema,
  );
  assertEquals(result.ok, true);
});
