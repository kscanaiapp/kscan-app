import { emptyResponse } from './engine.ts';
import type { DiscoveryFlags, DiscoveryInput, DiscoveryResponse } from './contracts.ts';
import { parseDiscoveryInput } from './validation.ts';

export type HandlerDependencies<T = DiscoveryResponse> = {
  flags: () => DiscoveryFlags;
  authenticate: (request: Request) => Promise<{ id: string; isAnonymous: boolean }>;
  claim: (id: string, signal: AbortSignal) => Promise<boolean>;
  discover: (input: DiscoveryInput, flags: DiscoveryFlags, signal: AbortSignal) => Promise<T>;
  completed?: (input: DiscoveryInput) => void;
};
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
async function boundedJson(request: Request, signal: AbortSignal): Promise<unknown> {
  if (!request.body || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid_body');
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 16_384) throw new Error('body_too_large');
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(data));
}
export function createDiscoveryHandler<T = DiscoveryResponse>(deps: HandlerDependencies<T>) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    const flags = deps.flags();
    // OFF is a local, zero-I/O return. No auth/catalog/network/write dependency.
    if (!flags.discovery && !flags.badges) {
      void request.body?.cancel().catch(() => undefined);
      return json(emptyResponse('unavailable', Date.now()));
    }
    if (request.method !== 'POST') { void request.body?.cancel().catch(() => undefined); return json({ error: 'method_not_allowed' }, 405); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = new Promise<Response>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
        resolve(json(emptyResponse('unavailable', Date.now())));
      }, { once: true });
      timer = setTimeout(abort, 2500);
    });
    const work = async () => {
      try {
        const user = await deps.authenticate(request);
        if (user.isAnonymous) return json({ error: 'account_required' }, 403);
        if (controller.signal.aborted) return json(emptyResponse('unavailable', Date.now()));
        let input: DiscoveryInput;
        try { input = parseDiscoveryInput(await boundedJson(request, controller.signal)); }
        catch { return json({ error: 'invalid_discovery_request' }, 400); }
        if (controller.signal.aborted) return json(emptyResponse('unavailable', Date.now()));
        if (!await deps.claim(user.id, controller.signal)) return json({ error: 'rate_limited' }, 429);
        const result = await deps.discover(input, flags, controller.signal);
        const response = json(result);
        // A scheduler only: background policy work must never be awaited here.
        try { deps.completed?.(input); } catch { /* shadow work cannot affect payload */ }
        return response;
      } catch (error) {
        if (error instanceof Response && error.status === 401) return json({ error: 'authentication_required' }, 401);
        return json(emptyResponse('unavailable', Date.now()));
      } finally { if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined); }
    };
    try { return await Promise.race([work(), unavailable]); }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); controller.abort(); }
  };
}
