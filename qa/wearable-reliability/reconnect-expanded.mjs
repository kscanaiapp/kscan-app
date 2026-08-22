import { callFn, frame, uuid, sleep } from './lib.mjs';
import { makeUserPool, pairOnce } from './pair.mjs';
import { sendCaptureRequest, glassesPoll, phonePoll, sendResultShow, doAction } from './ops.mjs';

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

async function main() {
  const pool = await makeUserPool(8, 'reconnect');

  // ---------- Reconnect during SCAN REQUEST: glasses sends, "disconnects"
  // before polling for anything back, reconnects, phone's poll (from cursor 0,
  // worst case) still sees the original capture.request. ----------
  const scanReqCases = await nTimes(10, async () => {
    const s = await pairOnce(pool.next().jwt);
    const { requestId } = await sendCaptureRequest(s);
    await sleep(400); // simulated disconnect before anyone polls
    const phoneSees = await phonePoll(s, s.jwt, 0); // phone "reconnects" and polls from scratch
    const frames = (phoneSees.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const capture = frames.find((f) => f.messageType === 'capture.request' && f.requestId === requestId);
    if (!capture) throw new Error('capture.request lost across reconnect before first poll');
    return true;
  });
  record('RECONNECT during scan request (capture.request survives a pre-poll gap)', scanReqCases.pass === 10, `${scanReqCases.pass}/10 (${scanReqCases.errs.slice(0, 3).join('; ')})`);

  // ---------- Reconnect during PROCESSING: phone sends multiple progress-ish
  // frames (capture.completed, scan.completed via a manual sequence) while
  // glasses is "disconnected", then glasses reconnects and must see ALL of
  // them in order from a stale cursor, not just the latest. ----------
  const processingCases = await nTimes(10, async () => {
    const s = await pairOnce(pool.next().jwt);
    const resultId = uuid();
    const f1 = JSON.parse(frame('capture.completed', s.sessionId, s.phoneDeviceId, { captureId: uuid() }));
    const f2 = JSON.parse(frame('scan.completed', s.sessionId, s.phoneDeviceId, { scanId: uuid(), resultId }));
    await callFn({ operation: 'phone.send', sessionId: s.sessionId, frame: JSON.stringify(f1) }, s.jwt);
    await callFn({ operation: 'phone.send', sessionId: s.sessionId, frame: JSON.stringify(f2) }, s.jwt);
    await sendResultShow(s, s.jwt, resultId);
    await sleep(400); // simulated disconnect spanning all three sends
    const poll = await glassesPoll(s, 0); // reconnect: poll from cursor 0
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const types = frames.map((f) => f.messageType);
    if (!types.includes('capture.completed') || !types.includes('scan.completed') || !types.includes('result.show')) {
      throw new Error(`missing frames after multi-message reconnect: got ${types.join(',')}`);
    }
    // Order must be preserved (cursor-ordered by id).
    const order = ['capture.completed', 'scan.completed', 'result.show'];
    const positions = order.map((t) => types.indexOf(t));
    if (positions[0] > positions[1] || positions[1] > positions[2]) throw new Error(`frame order not preserved: ${types.join(',')}`);
    return true;
  });
  record('RECONNECT during processing (multi-frame sequence survives, order preserved)', processingCases.pass === 10, `${processingCases.pass}/10 (${processingCases.errs.slice(0, 3).join('; ')})`);

  // ---------- Reconnect around RESULTS: already covered by matrix.mjs's
  // "reconnect" batch (10/10) — re-affirm with a longer gap here. ----------
  const resultsCases = await nTimes(10, async () => {
    const s = await pairOnce(pool.next().jwt);
    const resultId = uuid();
    await sendResultShow(s, s.jwt, resultId);
    await sleep(800); // longer gap than the original matrix test
    const poll = await glassesPoll(s, 0);
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const show = frames.find((f) => f.messageType === 'result.show' && f.payload?.result?.resultId === resultId);
    if (!show) throw new Error('result lost across an 800ms reconnect gap');
    return true;
  });
  record('RECONNECT around results (longer gap, re-affirmed)', resultsCases.pass === 10, `${resultsCases.pass}/10 (${resultsCases.errs.slice(0, 3).join('; ')})`);

  // ---------- Reconnect around SAVE: glasses sends a save action, then
  // "disconnects" before it would normally poll for the ack; on reconnect the
  // phone independently completes the action (phone.action is a direct call,
  // not something the glasses needs to be online for), and the glasses'
  // eventual session.poll must not show any stale/duplicate confirmation for
  // an action it never actually saw acknowledged the first time. ----------
  const saveCases = await nTimes(10, async () => {
    const s = await pairOnce(pool.next().jwt);
    const resultId = uuid();
    await sendResultShow(s, s.jwt, resultId);
    const save1 = await doAction(s, s.jwt, resultId, 'save');
    if (save1.res.json.duplicate !== false) throw new Error('expected fresh save before reconnect');
    await sleep(400); // simulated disconnect right after the save call
    // Reconnect: glasses re-polls. It must not receive a *second* unsolicited
    // save confirmation — completeWearableAction's ack is sent explicitly via
    // acknowledgeWearableAction (result.update), not by phone.action itself, so
    // a bare reconnect poll here should see nothing new for this action.
    const poll = await glassesPoll(s, 0);
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const spuriousAcks = frames.filter((f) => f.messageType === 'result.update').length;
    if (spuriousAcks > 0) throw new Error(`unsolicited save confirmation appeared after reconnect: ${spuriousAcks}`);
    // The save itself must still be durably recorded server-side regardless of
    // whether the glasses ever sees a frame for it.
    const save2 = await doAction(s, s.jwt, resultId, 'save');
    if (save2.res.json.duplicate !== true) throw new Error('save action lost across reconnect (expected duplicate:true on retry)');
    return true;
  });
  record('RECONNECT around Save (no unsolicited ack; action durably recorded)', saveCases.pass === 10, `${saveCases.pass}/10 (${saveCases.errs.slice(0, 3).join('; ')})`);

  // ---------- Reconnect around OPEN-ON-PHONE: same shape as Save. ----------
  const openCases = await nTimes(10, async () => {
    const s = await pairOnce(pool.next().jwt);
    const resultId = uuid();
    await sendResultShow(s, s.jwt, resultId);
    const open1 = await doAction(s, s.jwt, resultId, 'open_on_phone');
    if (open1.res.json.duplicate !== false) throw new Error('expected fresh open before reconnect');
    await sleep(400);
    const open2 = await doAction(s, s.jwt, resultId, 'open_on_phone');
    if (open2.res.json.duplicate !== true) throw new Error('open-on-phone action lost across reconnect');
    return true;
  });
  record('RECONNECT around Open-on-Phone (action durably recorded)', openCases.pass === 10, `${openCases.pass}/10 (${openCases.errs.slice(0, 3).join('; ')})`);

  console.log('\n=== SUMMARY ===');
  const allPass = results.every((r) => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(allPass ? '\nALL EXPANDED RECONNECT BATCHES PASS' : '\nSOME BATCHES FAILED');
  return { allPass };
}

main().then((r) => process.exit(r.allPass ? 0 : 1)).catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
