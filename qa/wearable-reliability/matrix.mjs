import { callFn, frame, uuid, sleep } from './lib.mjs';
import { makeTestUser, makeUserPool, pairOnce } from './pair.mjs';
import { scanCycle, doAction, revoke, revokeAll, glassesPoll, phonePoll, sendResultShow } from './ops.mjs';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function nTimes(n, fn) {
  let pass = 0;
  const errs = [];
  const out = await Promise.all(Array.from({ length: n }, (_, i) => fn(i).then(
    (r) => { pass++; return r; },
    (e) => { errs.push(String(e?.message ?? e)); return null; },
  )));
  return { pass, total: n, errs, out };
}

// Require an exact count of usable prior results before running a dependent
// batch — otherwise a short-count upstream batch silently produces a vacuous
// "0/0 PASS" downstream, which would misreport a real failure as a pass.
function requireCount(arr, n, label) {
  const usable = arr.filter(Boolean);
  if (usable.length < n) throw new Error(`${label}: only ${usable.length}/${n} usable prerequisites — cannot run this batch meaningfully`);
  return usable.slice(0, n);
}

async function main() {
  console.log('=== building shared user pool (sequential, staggered to respect signup rate limits) ===');
  const pool = await makeUserPool(10, 'matrix');
  console.log(`pool ready: ${pool.users.length} users`);

  // ---------- Pairing: 20/20 successful pair cycles ----------
  // Drawn round-robin from the pool (each user capped well under the server's
  // 10-per-2-minute pair.approve throttle) — models 20 different people pairing
  // their own glasses, not one account hammering pair.approve 20 times in a row.
  const pairBatch = await nTimes(20, () => pairOnce(pool.next().jwt));
  record('PAIRING 20/20 successful pair cycles', pairBatch.pass === 20, `${pairBatch.pass}/20 (${pairBatch.errs.slice(0, 3).join('; ')})`);
  const sessions = pairBatch.out.filter(Boolean);

  // ---------- Pairing: 10/10 wrong-session rejection ----------
  const wsPool = requireCount(sessions, 10, 'wrong-session pool');
  const wrongSession = await nTimes(10, async (i) => {
    const a = wsPool[i];
    const b = sessions[(i + 1) % sessions.length];
    const f = JSON.parse(frame('capture.request', a.sessionId, a.glassesDeviceId, {}));
    const res = await callFn({ operation: 'session.send', wearableToken: b.wearableToken, frame: JSON.stringify(f) });
    if (res.status === 200) throw new Error('expected rejection, got 200');
    if (res.json.code !== 'WRONG_SESSION') throw new Error(`expected WRONG_SESSION, got ${res.json.code}`);
    return true;
  });
  record('PAIRING 10/10 wrong-session attempts rejected', wrongSession.pass === 10, `${wrongSession.pass}/10 (${wrongSession.errs.slice(0, 3).join('; ')})`);

  // ---------- Pairing: 10/10 explicit revocations ----------
  const revPool = requireCount(sessions, 10, 'explicit-revoke pool');
  const revokeBatch = await nTimes(10, async (i) => {
    const s = revPool[i];
    const r = await revoke(s, s.jwt, 'user_revoked');
    if (r.status !== 200 || !r.json.ok) throw new Error(`revoke call failed: ${JSON.stringify(r.json)}`);
    const poll = await glassesPoll(s, 0);
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const revoked = frames.find((f) => f.messageType === 'session.revoked');
    if (!revoked || revoked.payload?.reason !== 'USER_REVOKED') throw new Error(`expected session.revoked USER_REVOKED, got ${JSON.stringify(frames)}`);
    const action = await doAction(s, s.jwt, uuid(), 'save');
    if (action.res.status === 200) throw new Error('phone.action succeeded on a revoked session');
    return true;
  });
  record('PAIRING 10/10 explicit revocations (+ protected action rejected after)', revokeBatch.pass === 10, `${revokeBatch.pass}/10 (${revokeBatch.errs.slice(0, 3).join('; ')})`);

  // ---------- Pairing: 10/10 phone-sign-out revocations ----------
  // One dedicated user pairs 10 devices (exactly at, not over, the 10-per-window
  // throttle), then a single sign-out (phone.revoke_all) must revoke all 10.
  const signOutUser = await makeTestUser('signout');
  const signOutPairs = await nTimes(10, () => pairOnce(signOutUser.jwt));
  const signOutSessions = requireCount(signOutPairs.out, 10, 'sign-out session pool');
  const signOutRes = await revokeAll(signOutUser.jwt);
  const signOutOk = signOutRes.status === 200 && signOutRes.json.ok;
  const signOutChecks = await nTimes(10, async (i) => {
    const s = signOutSessions[i];
    const poll = await glassesPoll(s, 0);
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const revoked = frames.find((f) => f.messageType === 'session.revoked');
    if (!revoked) throw new Error(`expected session.revoked frame, got ${JSON.stringify(frames)}`);
    return true;
  });
  record('PAIRING 10/10 phone-sign-out revocations', signOutPairs.pass === 10 && signOutOk && signOutChecks.pass === 10, `pairs=${signOutPairs.pass}/10 revokeAllOk=${signOutOk} checks=${signOutChecks.pass}/10 (${signOutChecks.errs.slice(0, 3).join('; ')})`);

  // ---------- Scan: 20/20 real-companion scan cycles ----------
  const scanPairs = await nTimes(20, () => pairOnce(pool.next().jwt));
  const scanSessions = requireCount(scanPairs.out, 20, 'scan session pool');
  const scanBatch = await nTimes(20, async (i) => {
    const s = scanSessions[i];
    const cycle = await scanCycle(s, s.jwt);
    const frames = (cycle.glassesSeesResult.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const show = frames.find((f) => f.messageType === 'result.show');
    if (!show) throw new Error('glasses never saw result.show');
    if (show.payload.result.resultId !== cycle.resultId) throw new Error('resultId mismatch (cross-session or stale result)');
    return cycle;
  });
  record('SCAN 20/20 real-companion scan cycles (capture -> phone -> result, resultId verified)', scanBatch.pass === 20, `${scanBatch.pass}/20 (${scanBatch.errs.slice(0, 3).join('; ')})`);

  // ---------- Actions: 10/10 Save, 10/10 Open-on-Phone, 10/10 duplicate idempotency ----------
  const actionCycles = requireCount(scanBatch.out, 10, 'action cycle pool');
  const actionSessions = scanSessions.slice(0, 10);
  const saveAcks = await nTimes(10, async (i) => {
    const r = await doAction(actionSessions[i], actionSessions[i].jwt, actionCycles[i].resultId, 'save');
    if (r.res.status !== 200 || r.res.json.duplicate !== false) throw new Error(`expected fresh save ack, got ${JSON.stringify(r.res.json)}`);
    return r;
  });
  record('ACTIONS 10/10 Save acknowledgements', saveAcks.pass === 10, `${saveAcks.pass}/10 (${saveAcks.errs.slice(0, 3).join('; ')})`);

  const openAcks = await nTimes(10, async (i) => {
    const r = await doAction(actionSessions[i], actionSessions[i].jwt, actionCycles[i].resultId, 'open_on_phone');
    if (r.res.status !== 200 || r.res.json.duplicate !== false) throw new Error(`expected fresh open ack, got ${JSON.stringify(r.res.json)}`);
    return r;
  });
  record('ACTIONS 10/10 Open-on-Phone acknowledgements', openAcks.pass === 10, `${openAcks.pass}/10 (${openAcks.errs.slice(0, 3).join('; ')})`);

  const dupSaves = await nTimes(10, async (i) => {
    const r = await doAction(actionSessions[i], actionSessions[i].jwt, actionCycles[i].resultId, 'save');
    if (r.res.status !== 200 || r.res.json.duplicate !== true) throw new Error(`expected duplicate:true, got ${JSON.stringify(r.res.json)}`);
    return r;
  });
  record('ACTIONS 10/10 duplicate Save idempotency cycles', dupSaves.pass === 10, `${dupSaves.pass}/10 (${dupSaves.errs.slice(0, 3).join('; ')})`);

  // ---------- Scan: 10/10 backend-error recovery ----------
  const errUser = await makeTestUser('errrecovery');
  const errSession = await pairOnce(errUser.jwt);
  const errorRecovery = await nTimes(10, async (i) => {
    const cases = [
      () => callFn({ operation: 'session.send', wearableToken: 'not-a-real-token', frame: '{}' }),
      () => callFn({ operation: 'phone.action', sessionId: 'nope', actionId: 'not-a-uuid', resultId: 'not-a-uuid', actionType: 'save' }, errUser.jwt),
      () => callFn({ operation: 'phone.action' }, errUser.jwt),
      () => callFn({ operation: 'session.poll', wearableToken: 'x'.repeat(200) }),
      () => callFn({ operation: 'pair.approve', challengeCode: '000000', phoneDeviceId: uuid() }, errUser.jwt),
      () => callFn({ operation: 'unknown.operation' }),
      () => callFn({ operation: 'session.send', wearableToken: errSession.wearableToken, frame: JSON.stringify({ protocolVersion: 99, messageType: 'x', requestId: uuid(), sessionId: errSession.sessionId, deviceId: uuid(), timestamp: Date.now() }) }),
      () => callFn({ operation: 'session.send', wearableToken: errSession.wearableToken, frame: JSON.stringify({ protocolVersion: 1, messageType: 'x', requestId: 'not-a-uuid', sessionId: errSession.sessionId, deviceId: uuid(), timestamp: Date.now() }) }),
      () => callFn({ operation: 'phone.send', sessionId: errSession.sessionId, frame: JSON.stringify({ protocolVersion: 1, messageType: 'result.show', requestId: uuid(), sessionId: errSession.sessionId, deviceId: uuid(), timestamp: Date.now(), payload: { image: 'data:image/jpeg;base64,AAAA' } }) }, errUser.jwt),
      () => callFn({ operation: 'phone.poll', sessionId: 'not-a-real-session' }, errUser.jwt),
    ];
    const r = await cases[i % cases.length]();
    if (r.status < 400 || r.status >= 500) throw new Error(`expected a safe 4xx error, got status ${r.status} body ${JSON.stringify(r.json)}`);
    if (r.json.ok !== false || typeof r.json.code !== 'string') throw new Error(`expected {ok:false,code}, got ${JSON.stringify(r.json)}`);
    return r;
  });
  record('SCAN 10/10 backend-error recovery (malformed/invalid input -> safe 4xx, never a crash)', errorRecovery.pass === 10, `${errorRecovery.pass}/10 (${errorRecovery.errs.slice(0, 3).join('; ')})`);

  // ---------- Scan: 10/10 reconnect (cursor-based poll resumption after a gap) ----------
  const reconnectPairs = await nTimes(10, () => pairOnce(pool.next().jwt));
  const reconnectSessions = requireCount(reconnectPairs.out, 10, 'reconnect session pool');
  const reconnect = await nTimes(10, async (i) => {
    const s = reconnectSessions[i];
    const resultId = uuid();
    await sendResultShow(s, s.jwt, resultId);
    await sleep(500); // simulated connection loss
    const poll = await glassesPoll(s, 0); // reconnect: poll from cursor 0, worst case (lost cursor state)
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const show = frames.find((f) => f.messageType === 'result.show' && f.payload?.result?.resultId === resultId);
    if (!show) throw new Error('message lost across simulated reconnect gap');
    return true;
  });
  record('SCAN 10/10 reconnect (cursor resume after gap, no message loss)', reconnect.pass === 10, `${reconnect.pass}/10 (${reconnect.errs.slice(0, 3).join('; ')})`);

  // ---------- Pairing: 10/10 replay attempts rejected ----------
  const replayPairs = await nTimes(10, () => pairOnce(pool.next().jwt));
  const replayPool = requireCount(replayPairs.out, 10, 'replay pool');
  const replay = await nTimes(10, async (i) => {
    const p = replayPool[i];
    const secondPoll = await callFn({ operation: 'pair.poll', pairingHandle: p.pairingHandle, pairingSecret: p.pairingSecret });
    const frames = secondPoll.json.poll?.frames ?? [];
    if (frames.length !== 0) throw new Error(`replay produced frames instead of empty: ${JSON.stringify(secondPoll.json)}`);
    if (secondPoll.json.poll?.wearableToken) throw new Error('replay issued a second wearableToken — session replay is possible');
    return true;
  });
  record('PAIRING 10/10 replay attempts rejected (no second session/token issued)', replay.pass === 10, `${replay.pass}/10 (${replay.errs.slice(0, 3).join('; ')})`);

  console.log('\n=== SUMMARY ===');
  const allPass = results.every((r) => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(allPass ? '\nALL BATCHES PASS' : '\nSOME BATCHES FAILED — see above');
  return { allPass, results };
}

main().then((r) => process.exit(r.allPass ? 0 : 1)).catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
