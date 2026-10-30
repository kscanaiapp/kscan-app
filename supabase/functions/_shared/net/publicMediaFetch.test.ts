import assert from 'node:assert/strict';
import { createPublicMediaLookup, publicMediaFetch, type MediaResolver } from './publicMediaFetch.ts';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { request } from 'node:https';

function lookup(addresses: Array<{ address: string; family: number }>, all = true) {
  return new Promise<{ error: Error | null; address: unknown; family?: number }>(resolve => {
    const resolver: MediaResolver = (_hostname, callback) => callback(null, addresses);
    createPublicMediaLookup(resolver)('synthetic.example', { all }, (error, address, family) => resolve({ error, address, family }));
  });
}

for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
  Deno.test(`C011 socket lookup denies resolved private address ${address}`, async () => {
    const result = await lookup([{ address, family: address.includes(':') ? 6 : 4 }]);
    assert.equal((result.error as NodeJS.ErrnoException)?.code, 'EACCES');
    assert.equal(result.address, undefined);
  });
}
Deno.test('C011 mixed public/private fallback is refused as a whole', async () => {
  assert.ok((await lookup([{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }])).error);
});
Deno.test('C011 valid public addresses preserve all/single lookup callback contracts', async () => {
  const rows = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }];
  assert.deepEqual(await lookup(rows), { error: null, address: rows, family: undefined });
  assert.deepEqual(await lookup(rows, false), { error: null, address: rows[0].address, family: 4 });
});
Deno.test('C011 empty/malformed/family-confused answers fail closed', async () => {
  for (const rows of [[], [{ address: 'not-an-ip.example', family: 4 }], [{ address: '127.0.0.1', family: 6 }]]) {
    assert.ok((await lookup(rows)).error);
  }
});
Deno.test('C011 DNS errors and resolver throws fail closed', async () => {
  for (const resolver of [
    ((_hostname, callback) => callback(new Error('fixture_dns_error'), [])) as MediaResolver,
    (() => { throw new Error('fixture_dns_throw'); }) as MediaResolver,
  ]) {
    await new Promise<void>(resolve => createPublicMediaLookup(resolver)('synthetic.example', {}, error => { assert.ok(error); resolve(); }));
  }
});
Deno.test('C011 socket lookup returns the vetted address directly, with no preflight/re-resolution phase', async () => {
  let calls = 0;
  const resolver: MediaResolver = (_host, callback) => callback(null, [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  await new Promise<void>(resolve => createPublicMediaLookup(resolver)('rebind.example', {}, (error, address) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); resolve(); }));
  assert.equal(calls, 1);
});
Deno.test('C011 unsafe URLs, methods, nonmanual redirects and pre-cancelled requests cannot reach transport', async () => {
  for (const url of ['https://127.0.0.1/a', 'file:///etc/passwd', 'gopher://localhost/a', 'https://cdn.example:444/a']) {
    await assert.rejects(publicMediaFetch(url, { redirect: 'manual' }));
  }
  await assert.rejects(publicMediaFetch('https://cdn.example/a', { method: 'POST', redirect: 'manual' }));
  await assert.rejects(publicMediaFetch('https://cdn.example/a', {}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(publicMediaFetch('https://cdn.example/a', { redirect: 'manual', signal: controller.signal }), { name: 'AbortError' });
});

function transport(status: number, rawHeaders: string[] = ['Content-Type', 'image/png'], body = new Uint8Array([1, 2, 3])) {
  const seen: Array<{ url: string; options: Record<string, unknown> }> = [];
  const response = Object.assign(Readable.from([body]), { statusCode: status, rawHeaders });
  const requestImpl = ((url: string, options: Record<string, unknown>, onResponse: (response: unknown) => void) => {
    seen.push({ url, options });
    return Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => onResponse(response)) });
  }) as unknown as typeof request;
  return { seen, response, requestImpl };
}
for (const status of [200, 429, 500]) {
  Deno.test(`C011 HTTP ${status} and response bytes remain authoritative`, async () => {
    const fixture = transport(status);
    const response = await publicMediaFetch('https://cdn.example/a.png?sig=synthetic', { redirect: 'manual' }, fixture.requestImpl);
    assert.equal(response.status, status); assert.equal(response.ok, status === 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(fixture.seen[0].url, 'https://cdn.example/a.png?sig=synthetic');
    assert.equal(fixture.seen[0].options.rejectUnauthorized, true);
    assert.equal(fixture.seen[0].options.method, 'GET');
    assert.equal(fixture.seen[0].options.maxHeaderSize, 32768);
    const agent = fixture.seen[0].options.agent as { options: { proxyEnv: unknown } };
    assert.deepEqual(agent.options.proxyEnv, {});
  });
}
for (const status of [301, 304, 204, 205]) {
  Deno.test(`C011 HTTP ${status} has no leaked response stream`, async () => {
    const fixture = transport(status, ['Location', 'https://cdn.example/next.png']);
    const response = await publicMediaFetch('https://cdn.example/a.png', { redirect: 'manual' }, fixture.requestImpl);
    assert.equal(response.status, status); assert.equal(response.body, null);
    assert.equal(fixture.response.destroyed, true);
  });
}
Deno.test('C011 malformed upstream status/headers reject instead of crashing or fabricating success', async () => {
  for (const fixture of [transport(999), transport(200, ['invalid\nheader', 'value'])]) {
    await assert.rejects(publicMediaFetch('https://cdn.example/a.png', { redirect: 'manual' }, fixture.requestImpl));
    assert.equal(fixture.response.destroyed, true);
  }
});
