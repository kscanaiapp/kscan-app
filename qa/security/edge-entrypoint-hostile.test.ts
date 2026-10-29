/** Offline probes of real entry handlers. No network permission is granted. */
const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await Deno.readTextFile(new URL('config/edge-function-manifest.json', root)));
const targets: string[] = manifest.parity.expectedFunctions;
const envNames = new Set(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
async function inventoryEnv(dir: URL): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
    if (entry.isDirectory) await inventoryEnv(path);
    else if (entry.name.endsWith('.ts')) {
      const source = await Deno.readTextFile(path);
      for (const match of source.matchAll(/(?:Deno\.env\.get|\benv|\benvOptional)\(['"]([A-Z][A-Z0-9_]+)['"]\)/g)) envNames.add(match[1]);
    }
  }
}
await inventoryEnv(new URL('supabase/functions/', root));

for (const endpoint of targets) {
  Deno.test({
    name: `offline real entrypoint hostile probes: ${endpoint}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const saved = new Map([...envNames].map((name) => [name, Deno.env.get(name)]));
      const realFetch = globalThis.fetch;
      const realServeDescriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
      let handler: ((req: Request) => Response | Promise<Response>) | undefined;
      let providerCalls = 0;
      let writes = 0;
      try {
        for (const name of envNames) Deno.env.set(name, name === 'SUPABASE_URL'
          ? 'https://hostile-fixture.invalid' : /ENABLED/.test(name) && !/SPONSOR/.test(name) ? 'true'
          : /_MODE$|SPONSOR/.test(name) ? 'false' : 'hostile-fixture-only');
        globalThis.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          if (!url.startsWith('https://hostile-fixture.invalid/')) providerCalls++;
          if (url.includes('/rest/v1/') && method !== 'GET') writes++;
          return Response.json({ message: 'Invalid fixture token', error: 'unauthorized' }, { status: 401 });
        };
        Object.defineProperty(Deno, 'serve', { configurable: true, value: (first: unknown, second: unknown) => {
          handler = (typeof first === 'function' ? first : second) as typeof handler;
          return { finished: Promise.resolve(), shutdown: async () => {} };
        } });
        try {
          await import(new URL(`supabase/functions/${endpoint}/index.ts`, root).href);
        } catch (error) {
          console.log('HOSTILE_RESULT ' + JSON.stringify({ endpoint, probe: 'entrypoint import', verdict: 'NOT TESTED',
            actual: error instanceof Error ? error.name + ': ' + error.message : 'import failed',
            reason: 'Entry module cannot be loaded in the offline Deno harness; no endpoint security verdict inferred.' }));
          return;
        }
        if (!handler) throw new Error('No Deno.serve handler captured');
        const cases = [
          { probe: 'anonymous caller / empty body', body: '', token: '' },
          { probe: 'null body', body: 'null', token: '' },
          { probe: 'malformed JSON', body: '{', token: '' },
          { probe: 'wrong schema array', body: '[]', token: '' },
          { probe: 'malformed JWT', body: '{}', token: 'not-a-jwt' },
          { probe: 'tampered JWT claims', body: '{}', token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3JlaWduLWFjdG9yIn0.' },
        ];
        const failures: string[] = [];
        for (const entry of cases) {
          providerCalls = 0;
          writes = 0;
          let status: number | string;
          try {
            status = (await handler(new Request(`https://hostile-fixture.invalid/functions/v1/${endpoint}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', ...(entry.token ? { Authorization: `Bearer ${entry.token}` } : {}) },
              body: entry.body,
            }))).status;
          } catch (error) { status = error instanceof Error ? error.name : 'unhandled rejection'; }
          const verdict = providerCalls === 0 && writes === 0 && typeof status === 'number' ? 'PASS' : 'FAIL';
          console.log('HOSTILE_RESULT ' + JSON.stringify({ endpoint, probe: entry.probe,
            expected: 'No provider dispatch, no privileged write, controlled response to invalid/unauthorized input',
            actual: { status, providerCalls, writes }, verdict, environment: 'offline fake auth/backend; actual handler',
            limitation: 'PASS is limited to no-dispatch/no-write/controlled-response; HTTP status and authenticated resource isolation are separate assertions.' }));
          if (verdict === 'FAIL') failures.push(`${endpoint}: ${entry.probe} violated no-side-effect/controlled-response contract`);
        }
        if (failures.length) throw new Error(failures.join('; '));
      } finally {
        globalThis.fetch = realFetch;
        Object.defineProperty(Deno, 'serve', realServeDescriptor);
        for (const [name, value] of saved) value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
      }
    },
  });
}
