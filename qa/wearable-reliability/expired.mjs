import { callFn, frame, uuid, sleep } from './lib.mjs';

// pair.create needs no user/auth at all, so this test avoids the signup rate
// limiter entirely. Create 10 challenges up front, wait once for the 120s TTL to
// pass (not 10x), then poll all 10 and confirm each reports pair.expired with no
// session/token ever issued.
async function main() {
  const tickets = [];
  for (let i = 0; i < 10; i += 1) {
    const glassesDeviceId = uuid();
    const f = JSON.parse(frame('pair.request', '', glassesDeviceId, { model: 'XR-Reliability-Harness', appVersion: '0.0.0-harness' }));
    const create = await callFn({ operation: 'pair.create', frame: JSON.stringify(f) });
    if (create.status !== 200 || !create.json.ticket) throw new Error(`pair.create ${i} failed: ${create.status} ${JSON.stringify(create.json)}`);
    tickets.push({ ...create.json.ticket, glassesDeviceId });
  }
  console.log(`created ${tickets.length} pairing challenges at ${new Date().toISOString()}, waiting for TTL...`);

  const waitMs = Math.max(0, tickets[0].expiresAt - Date.now()) + 10_000; // +10s safety margin past TTL
  console.log(`waiting ${Math.round(waitMs / 1000)}s for pairing TTL to elapse`);
  await sleep(waitMs);

  let pass = 0;
  const errs = [];
  for (let i = 0; i < tickets.length; i += 1) {
    const t = tickets[i];
    const poll = await callFn({ operation: 'pair.poll', pairingHandle: t.pairingHandle, pairingSecret: t.pairingSecret });
    const frames = (poll.json.poll?.frames ?? []).map((f) => JSON.parse(f));
    const expired = frames.find((f) => f.messageType === 'pair.expired');
    if (!expired) { errs.push(`ticket ${i}: no pair.expired frame, got ${JSON.stringify(poll.json)}`); continue; }
    if (poll.json.poll?.wearableToken) { errs.push(`ticket ${i}: a wearableToken was issued for an expired challenge`); continue; }
    pass++;
  }
  console.log(`\nPAIRING ${pass}/10 expired challenges rejected`);
  if (errs.length) console.log('errors:', errs.slice(0, 5).join('\n'));
  process.exit(pass === 10 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
