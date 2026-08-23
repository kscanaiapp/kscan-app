import { callFn, frame, uuid, sleep } from './lib.mjs';
import { makeUserPool, pairOnce } from './pair.mjs';

async function sendResultUpdate(session, resultId, revision) {
  const f = JSON.parse(frame('result.update', session.sessionId, session.phoneDeviceId, {
    result: { resultId, revision, summary: `rev${revision}`, scanStatus: 'completed' },
    revision,
  }));
  return callFn({ operation: 'phone.send', sessionId: session.sessionId, frame: JSON.stringify(f) }, session.jwt);
}

async function main() {
  const pool = await makeUserPool(3, 'stalerev');
  let pass = 0;
  const errs = [];
  const total = 10;

  for (let i = 0; i < total; i++) {
    try {
      const s = await pairOnce(pool.next().jwt);
      const resultId = uuid();
      const r1 = await sendResultUpdate(s, resultId, 3);
      if (r1.status !== 200 || !r1.json.ok) throw new Error(`initial revision 3 write failed: ${JSON.stringify(r1.json)}`);

      // Stale write: revision 1 after revision 3 already exists — must be rejected.
      const stale = await sendResultUpdate(s, resultId, 1);
      if (stale.status !== 400 || stale.json.code !== 'STALE_REVISION') {
        throw new Error(`stale revision not rejected: status=${stale.status} body=${JSON.stringify(stale.json)}`);
      }

      // Equal-revision resend: must be idempotent (ok:true, no error), not rejected
      // and not treated as a fresh confirmation either.
      const same = await sendResultUpdate(s, resultId, 3);
      if (same.status !== 200 || !same.json.ok) throw new Error(`equal-revision resend not accepted as idempotent: ${JSON.stringify(same.json)}`);

      pass++;
    } catch (e) {
      errs.push(String(e?.message ?? e));
    }
  }

  console.log(`PAIRING/SCAN ${pass}/${total} stale-revision rejected + equal-revision idempotent-resend accepted`);
  if (errs.length) console.log('errors:', errs.slice(0, 5).join('\n'));
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => { console.error('CRASHED', e); process.exit(2); });
