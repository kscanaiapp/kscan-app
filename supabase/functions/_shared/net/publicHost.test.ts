import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isNonPublicHost as copy } from './publicHost.ts';
import { isNonPublicHost as original } from './safeRemoteMedia.ts';

// publicHost.ts holds a VERBATIM copy of the host check in safeRemoteMedia.ts so
// the mobile app can import it without pulling in the server-side media fetcher
// (and without touching the paid-provider boundary file). Two copies of a
// security predicate are only acceptable while they cannot drift, so this pins
// the behaviour here; the source-text identity is pinned by
// __tests__/publicHostParity.test.js (a Deno test cannot read files under the
// repository's restricted test permissions).

const HOSTS = [
  'localhost', 'app.localhost', 'localhost.localdomain', 'intranet', '', '   ',
  '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '172.32.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '100.127.255.255', '100.128.0.1', '192.0.0.1', '224.0.0.1', '0.0.0.0',
  '8.8.8.8', '93.184.216.34', '1.1.1.1', '256.1.1.1', '999.1.1.1',
  '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '[::1]', '[::ffff:127.0.0.1]', '::ffff:7f00:1',
  '::ffff:8.8.8.8', '::ffff:808:808', '::ffff:zzzz', '2001:4860:4860::8888',
  '2130706433', '0x7f000001', '017700000001', '0177', '12345',
  'example.com', 'shop.example.co.uk', 'www.google.com', 'EXAMPLE.COM', ' Example.com ',
];

Deno.test('the copy behaves exactly like the original on a broad host corpus', () => {
  for (const host of HOSTS) assertEquals(copy(host), original(host), JSON.stringify(host));
});
