import { callFn, frame, uuid, signUp, sleep } from './lib.mjs';

export async function makeTestUser(tag, retries = 4) {
  const email = `xr-reliability-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@kscan-test.invalid`;
  const password = `Harness!${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const signup = await signUp(email, password);
    if (signup.status === 200 && signup.json.access_token) {
      return { email, userId: signup.json.user.id, jwt: signup.json.access_token };
    }
    if (signup.json?.error_code === 'over_request_rate_limit' && attempt < retries) {
      await sleep(4000 * (attempt + 1)); // GoTrue signup is a slow-refill token bucket; back off and retry.
      continue;
    }
    throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.json)}`);
  }
}

// A small pool of throwaway users, created sequentially with light staggering to
// stay under GoTrue's own signup burst limiter (hit at ~20 concurrent signups in
// testing). Each real person pairs their own device only occasionally, so a pool
// reused round-robin — capped well under the server's 10-pair.approve-per-user
// per 2-minute throttle — models real usage far better than a fresh signup per
// pairing cycle would.
export async function makeUserPool(size, tag = 'pool') {
  const pool = [];
  for (let i = 0; i < size; i += 1) {
    pool.push(await makeTestUser(`${tag}${i}`));
    await sleep(3000);
  }
  const usage = new Map(pool.map((u) => [u.userId, 0]));
  let cursor = 0;
  return {
    users: pool,
    next(cap = 8) {
      for (let tries = 0; tries < pool.length; tries += 1) {
        const u = pool[cursor % pool.length];
        cursor += 1;
        if ((usage.get(u.userId) ?? 0) < cap) {
          usage.set(u.userId, usage.get(u.userId) + 1);
          return u;
        }
      }
      throw new Error('user pool exhausted (every user hit the per-window pairing cap)');
    },
  };
}

// Full glasses-side pair.create -> phone-side pair.approve -> glasses-side pair.poll.
// Returns everything needed to act as either the glasses or the phone for this session.
// pair.approve is rate-limited server-side to 10 attempts per user per 2-minute
// window (a real, deliberate anti-brute-force control) — so by default each call
// mints its own throwaway user, matching how pairing actually happens (one user
// pairing their own device), not many pairings hammering a single account.
export async function pairOnce(userJwt, tag = 'pair') {
  let jwt = userJwt;
  let userId;
  if (!jwt) {
    const user = await makeTestUser(tag);
    jwt = user.jwt;
    userId = user.userId;
  }
  const glassesDeviceId = uuid();
  const phoneDeviceId = uuid();

  const createFrame = JSON.parse(frame('pair.request', '', glassesDeviceId, { model: 'XR-Reliability-Harness', appVersion: '0.0.0-harness' }));
  const create = await callFn({ operation: 'pair.create', frame: JSON.stringify(createFrame) });
  if (create.status !== 200 || !create.json.ticket) {
    throw new Error(`pair.create failed: ${create.status} ${JSON.stringify(create.json)}`);
  }
  const { pairingHandle, challengeCode, pairingSecret } = create.json.ticket;

  const approve = await callFn(
    { operation: 'pair.approve', challengeCode, phoneDeviceId },
    jwt,
  );
  if (approve.status !== 200 || !approve.json.ok) {
    throw new Error(`pair.approve failed: ${approve.status} ${JSON.stringify(approve.json)}`);
  }

  const poll = await callFn({ operation: 'pair.poll', pairingHandle, pairingSecret, phoneAppVersion: 'K Scan Harness' });
  if (poll.status !== 200 || !poll.json.poll?.wearableToken && !poll.json.wearableToken) {
    throw new Error(`pair.poll failed: ${poll.status} ${JSON.stringify(poll.json)}`);
  }
  const wearableToken = poll.json.poll.wearableToken;
  const frames = (poll.json.poll.frames ?? []).map((f) => JSON.parse(f));
  const readyFrame = frames.find((f) => f.messageType === 'session.ready');
  if (!readyFrame) throw new Error(`no session.ready frame in poll: ${JSON.stringify(poll.json)}`);

  return {
    sessionId: readyFrame.sessionId,
    wearableToken,
    glassesDeviceId,
    phoneDeviceId,
    pairingHandle,
    pairingSecret,
    jwt,
    userId,
  };
}

export { sleep };
