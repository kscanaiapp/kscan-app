import assert from 'node:assert/strict';
import { createAiLabToolsProvider } from '../../supabase/functions/vto-generate/providers/aiLabToolsProvider.ts';
import { publicMediaFetch } from '../../supabase/functions/_shared/net/publicMediaFetch.ts';
import { MOCK_VTO_RESULT_BASE64 } from '../../supabase/functions/vto-generate/providers/mockResultAsset.ts';

Deno.test('C011 default media transport rejects DNS loopback before any controlled socket contact', async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 443 });
  let connections = 0, submitCalls = 0;
  const accepted = (async () => { try { const conn = await listener.accept(); connections++; conn.close(); } catch (e) { if (!(e instanceof Deno.errors.BadResource) && !(e instanceof Deno.errors.Interrupted)) throw e; } })();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('rapidapi.com')) { submitCalls++; throw new Error('Provider requests prohibited by fixture'); }
    return previousFetch(input, init);
  }) as typeof fetch;
  let outcome, directDenial;
  try {
    // No injected fetchImpl: exercise the actual production media default.
    const provider = createAiLabToolsProvider({ apiKey: 'OFFLINE-NONSECRET' });
    outcome = await provider.generate({ personDataUri: `data:image/png;base64,${MOCK_VTO_RESULT_BASE64}`, garmentImageUrl: 'https://127.0.0.1.nip.io/synthetic.png', slot: 'top', canonicalCategory: 'outerwear' }, { signal: new AbortController().signal });
    try { await publicMediaFetch('https://127.0.0.1.nip.io/synthetic.png', { redirect: 'manual' }); }
    catch (e) { directDenial = (e as NodeJS.ErrnoException).code; }
  } finally { globalThis.fetch = previousFetch; listener.close(); await accepted; }
  console.log(JSON.stringify({ connections, submitCalls, directDenial, outcome, limitation: 'Local Deno2.8.2 actual Node-HTTPS/DNS lookup and default adapter; not Supabase Edge or Production egress attestation' }));
  assert.equal(connections, 0); assert.equal(submitCalls, 0); assert.equal(directDenial, 'EACCES');
  assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.billable, false);
});

Deno.test('C011 an environment proxy cannot bypass the checked media DNS lookup', async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 443 });
  let connections = 0, directDenial;
  const accepted = (async () => { try { const conn = await listener.accept(); connections++; conn.close(); } catch (e) { if (!(e instanceof Deno.errors.BadResource) && !(e instanceof Deno.errors.Interrupted)) throw e; } })();
  const overrides = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:443', HTTP_PROXY: 'http://127.0.0.1:443', NO_PROXY: '' };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, Deno.env.get(key)]));
  try {
    for (const [key, value] of Object.entries(overrides)) Deno.env.set(key, value);
    try { await publicMediaFetch('https://127.0.0.1.nip.io/synthetic.png', { redirect: 'manual' }); }
    catch (e) { directDenial = (e as NodeJS.ErrnoException).code; }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
    listener.close(); await accepted;
  }
  console.log(JSON.stringify({ connections, directDenial, scenario: 'Synthetic process-scoped proxy settings restored; prior environment values never logged' }));
  assert.equal(connections, 0); assert.equal(directDenial, 'EACCES');
});
