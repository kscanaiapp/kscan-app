/** Actual handler, injected authoritative backend; no network permissions. */
const sourceRoot = Deno.env.get('KSCAN_AUDIT_SOURCE_ROOT') ?? 'C:/b35dnspromote1030/';
const root = new URL('file:///' + sourceRoot.replaceAll('\\', '/').replace(/\/?$/, '/'));
const own = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const room = '33333333-3333-4333-8333-333333333333';
const owner = '44444444-4444-4444-8444-444444444444';
const origin = 'https://shared-fixture.invalid';
const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };

Deno.test('actual public share handler: capability authority, input and backend failure boundaries', async () => {
  const envKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const saved = envKeys.map(k => Deno.env.get(k));
  const realFetch = globalThis.fetch;
  const serve = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
  let handler: (r: Request) => Promise<Response>;
  let mode = 'baseline';
  let failureAt = 'shares';
  let calls: string[] = [];
  try {
    Deno.env.set('SUPABASE_URL', origin);
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-server-key-not-secret');
    Object.defineProperty(Deno, 'serve', { configurable: true, value: (h: typeof handler) => {
      handler = h; return { finished: Promise.resolve(), shutdown: async () => {} };
    } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert(url.origin === origin, 'No unexpected external target');
      const headers = new Headers(init?.headers);
      assert(headers.get('Authorization') === 'Bearer synthetic-server-key-not-secret', 'Server authority required');
      calls.push(url.pathname);
      const stage = url.pathname.includes('/room_shares') ? 'shares' : url.pathname.includes('/dressing_rooms') ? 'rooms' : url.pathname.includes('/dressing_room_items') ? 'items' : 'sign';
      if (stage === failureAt) {
        if (mode === 'backend500') return Response.json({}, { status: 500 });
        if (mode === 'backend429') return Response.json({}, { status: 429 });
        if (mode === 'backend401') return Response.json({}, { status: 401 });
        if (mode === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError');
        if (mode === 'malformed') return new Response('{');
        if (mode === 'empty') return new Response('');
        if (mode === 'wrongSchema') return Response.json(null);
      }
      if (url.pathname === '/rest/v1/room_shares') {
        assert(url.searchParams.get('is_active') === 'eq.true', 'Only active shares');
        assert(url.searchParams.get('revoked_at') === 'is.null', 'Revoked shares excluded');
        assert(url.searchParams.get('access_level') === 'eq.view', 'View capability required');
        const token = url.searchParams.get('share_token');
        if (token !== 'eq.allowed-token' || mode === 'revoked') return Response.json([]);
        return Response.json([{room_id: room, expires_at: mode === 'expired' ? '2000-01-01T00:00:00Z' : null}]);
      }
      if (url.pathname === '/rest/v1/dressing_rooms') {
        assert(url.searchParams.get('id') === 'eq.' + room, 'Room comes from authoritative capability');
        return Response.json([{ id: room, user_id: owner }]);
      }
      if (url.pathname === '/rest/v1/dressing_room_items') {
        assert(url.searchParams.get('dressing_room_id') === 'eq.' + room, 'Items constrained to shared room');
        const ids = url.searchParams.get('id') ?? '';
        return Response.json(ids.includes(own) ? [{id: own, storage_bucket: 'style-library-images', storage_path: owner + '/scans/fixture.jpg'}] : []);
      }
      if (url.pathname.startsWith('/storage/v1/object/sign/')) {
        assert(url.pathname === '/storage/v1/object/sign/style-library-images/' + owner + '/scans/fixture.jpg', 'No client-chosen storage path');
        assert(init?.method === 'POST', 'Sign only by server POST');
        if (mode === 'signFailure') return Response.json({}, {status: 500});
        return Response.json({signedURL: '/object/sign/synthetic-result?token=synthetic'});
      }
      throw Error('Unexpected fixture boundary: ' + url.pathname);
    };
    await import(new URL('supabase/functions/shared-room-image-url/index.ts', root).href);
    const valid = {shareToken: 'allowed-token', itemIds: [own]};
    const cases: {id:string; body:string; status:number; mode?:string; failureAt?:string; signed?:boolean; noSign?:boolean; noCalls?:boolean; noSignResult?:boolean; noSuccess?:boolean}[] = [
      {id:'public-capability-baseline', body:JSON.stringify(valid), status:200, signed:true},
      {id:'unknown-capability', body:JSON.stringify({...valid, shareToken:'unknown-token'}), status:404},
      {id:'revoked-capability', body:JSON.stringify(valid), mode:'revoked', status:404},
      {id:'expired-capability', body:JSON.stringify(valid), mode:'expired', status:404},
      {id:'foreign-room-item', body:JSON.stringify({...valid, itemIds:[foreign]}), status:200, noSign:true},
      {id:'client-storage-path-ignored', body:JSON.stringify({...valid, storage_bucket:'private', storage_path:foreign+'/secret'}), status:200, signed:true},
      ...['', 'null', '{', '[]', '{}'].map((body, i) => ({id:'invalid-body-'+i, body, status:i===0||i===2?500:400, noCalls:true})),
      ...['../allowed-token', 'allоwed-token', "x') OR 1=1--", 'http://169.254.169.254/', 'file:///secret', 'gopher://localhost'].map((shareToken,i) => ({id:'invalid-capability-'+i,body:JSON.stringify({...valid,shareToken}),status:400,noCalls:true})),
      {id:'invalid-item-type',body:JSON.stringify({...valid,itemIds:[{},null,10,foreign+'/../'+own]}),status:400,noCalls:true},
      ...['shares','rooms','items','sign'].flatMap(failureAt => ['backend500','backend429','backend401','timeout','malformed','empty','wrongSchema'].map(mode=>({
        id:failureAt+'-'+mode, mode, failureAt, body:JSON.stringify(valid),
        status: /^backend/.test(mode) ? (failureAt==='shares'||failureAt==='rooms'?404:200) : mode==='wrongSchema' && failureAt==='sign' ? 200 : 500,
        noSign:failureAt!=='sign', noSuccess:true,
      }))),
      {id:'storage-sign-failure',mode:'signFailure',body:JSON.stringify(valid),status:200,noSignResult:true},
    ];
    for (const c of cases) {
      mode = c.mode ?? 'baseline'; failureAt = c.failureAt ?? 'shares'; calls = [];
      const response = await handler!(new Request(origin, {method:'POST', headers:{'Content-Type':'application/json'}, body:c.body}));
      const payload = await response.json();
      assert(response.status===c.status, c.id+': status '+response.status+' expected '+c.status);
      const signedCalls=calls.filter(p=>p.startsWith('/storage/')).length;
      if(c.signed) assert(signedCalls===1 && typeof payload.imageUrls?.[own]==='string',c.id+': real authoritative sign required');
      if(c.noSign) assert(signedCalls===0,c.id+': must not sign');
      if(c.noCalls) assert(calls.length===0,c.id+': malformed input touched backend');
      if(c.noSignResult) assert(payload.imageUrls?.[own]===null,c.id+': no fabricated signed URL');
      if(c.noSuccess) assert(!JSON.stringify(payload).includes('synthetic-result'),c.id+': backend failure fabricated access');
      if(c.id==='foreign-room-item') assert(payload.imageUrls?.[foreign]===null,'Foreign identifier must not reveal existence');
      console.log('SHARED_CAPABILITY_PROBE '+JSON.stringify({probeId:'B35-SHARE-'+c.id,sourceSha:'06e1e1e5afd9c179f68e0a51090d60beb8582a9c',environment:'Actual handler; offline synthetic backend; network denied',input:c.id,expected:{status:c.status,noSign:!!c.noSign,noBackend:!!c.noCalls},actual:{status:response.status,backendCalls:calls.length,signedCalls},verdict:'PASS',limitation:'Capability-authorized public route; not JWT validation, real database RLS, membership removal, signed URL expiry or native UI certification'}));
    }
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno,'serve',serve);
    envKeys.forEach((k,i)=>saved[i]===undefined?Deno.env.delete(k):Deno.env.set(k,saved[i]!));
  }
});
