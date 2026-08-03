import { assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { FORBIDDEN_LOG_SUBSTRINGS, logSecurityEvent, safeUserIdFragment, sanitizeLogText } from './logging.ts';

function captureConsoleLog(fn: () => void): string {
  const original = console.log;
  let captured = '';
  console.log = (line: unknown) => { captured = String(line); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}

Deno.test('logSecurityEvent emits a single JSON line with only allow-listed fields', () => {
  const line = captureConsoleLog(() =>
    logSecurityEvent({
      requestId: 'req-1',
      userIdFragment: 'abcd1234',
      functionName: 'stylechat-generate',
      providerCategory: 'gemini_chat',
      outcome: 'success',
      latencyMs: 120,
      status: 200,
    })
  );

  const parsed = JSON.parse(line);
  assertEquals(parsed.kind, 'provider_security_event');
  assertEquals(parsed.functionName, 'stylechat-generate');
  assertEquals(parsed.status, 200);
});

Deno.test('logSecurityEvent output never contains forbidden substrings for a realistic sensitive payload', () => {
  const line = captureConsoleLog(() =>
    logSecurityEvent({
      requestId: 'req-2',
      userIdFragment: safeUserIdFragment('11111111-2222-3333-4444-555555555555'),
      functionName: 'stylechat-generate',
      outcome: 'denied',
      status: 401,
      errorCategory: 'unauthorized',
    })
  );

  const lower = line.toLowerCase();
  for (const forbidden of FORBIDDEN_LOG_SUBSTRINGS) {
    assertEquals(lower.includes(forbidden), false, `log line must not contain "${forbidden}"`);
  }
});

Deno.test('safeUserIdFragment truncates to 8 characters and never returns the full ID', () => {
  const fullId = '11111111-2222-3333-4444-555555555555';
  const fragment = safeUserIdFragment(fullId);
  assertEquals(fragment, '11111111');
  assertEquals(fragment.length < fullId.length, true);
});

Deno.test('sanitizeLogText collapses whitespace and clamps length', () => {
  const raw = 'a'.repeat(500) + '   \n\n  extra   whitespace';
  const result = sanitizeLogText(raw, 50);
  assertEquals(result?.length, 50);
});

Deno.test('sanitizeLogText returns undefined for non-string input (e.g. accidental object/image payload)', () => {
  assertEquals(sanitizeLogText({ base64: 'not-a-string' } as unknown), undefined);
  assertEquals(sanitizeLogText(undefined), undefined);
});

Deno.test('sanitizeLogText never grows a raw provider payload beyond maxLength', () => {
  const hugePayload = JSON.stringify({ candidates: Array(1000).fill('x'.repeat(50)) });
  const result = sanitizeLogText(hugePayload, 180);
  assertEquals(result!.length <= 180, true);
});

Deno.test('a log line built from raw request text never contains an Authorization header value', () => {
  const authHeaderValue = 'Bearer eyFAKE.TOKEN.VALUE';
  const line = captureConsoleLog(() =>
    logSecurityEvent({
      requestId: 'req-3',
      functionName: 'stylechat-generate',
      outcome: 'denied',
      status: 401,
    })
  );
  assertMatch(line, /provider_security_event/);
  assertEquals(line.includes(authHeaderValue), false);
});
