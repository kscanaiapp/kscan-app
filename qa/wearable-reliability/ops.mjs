import { callFn, frame, uuid, stableActionId } from './lib.mjs';

// ---- glasses-side sends (session.send, wearableToken) ----

export async function sendCaptureRequest(session) {
  const requestId = uuid();
  const f = JSON.parse(frame('capture.request', session.sessionId, session.glassesDeviceId, { preference: 'PHONE_CAMERA' }));
  const overridden = { ...f, requestId };
  const res = await callFn({ operation: 'session.send', wearableToken: session.wearableToken, frame: JSON.stringify(overridden) });
  return { requestId, res };
}

export async function glassesPoll(session, after = 0) {
  return callFn({ operation: 'session.poll', wearableToken: session.wearableToken, after });
}

// ---- phone-side (phone.poll / phone.send / phone.action, requires user JWT) ----

export async function phonePoll(session, jwt, after = 0) {
  return callFn({ operation: 'phone.poll', sessionId: session.sessionId, after }, jwt);
}

function normalizedResult(resultId) {
  return {
    resultId,
    revision: 1,
    summary: 'Black fitted top',
    metadata: { category: 'Tops', color: 'Black' },
    products: [{ title: 'Leather Biker Jacket', brand: 'Test Brand', price: '129.00', currency: 'USD', group: 'RETAIL' }],
    scanStatus: 'completed',
  };
}

export async function sendResultShow(session, jwt, resultId) {
  const f = JSON.parse(frame('result.show', session.sessionId, session.phoneDeviceId, { result: normalizedResult(resultId) }));
  return callFn({ operation: 'phone.send', sessionId: session.sessionId, frame: JSON.stringify(f) }, jwt);
}

export async function sendResultUpdate(session, jwt, resultId, revision) {
  const result = normalizedResult(resultId);
  result.revision = revision;
  const f = JSON.parse(frame('result.update', session.sessionId, session.phoneDeviceId, { result, revision }));
  return callFn({ operation: 'phone.send', sessionId: session.sessionId, frame: JSON.stringify(f) }, jwt);
}

export async function doAction(session, jwt, resultId, actionType) {
  const actionId = stableActionId(actionType === 'save' ? 'save' : 'open', resultId);
  const res = await callFn({ operation: 'phone.action', sessionId: session.sessionId, actionId, resultId, actionType }, jwt);
  return { actionId, res };
}

export async function revoke(session, jwt, reason) {
  return callFn({ operation: 'phone.revoke', sessionId: session.sessionId, reason }, jwt);
}

export async function revokeAll(jwt) {
  return callFn({ operation: 'phone.revoke_all' }, jwt);
}

// One full glasses-triggered scan cycle: capture.request -> phone sees it -> phone
// sends result.show -> glasses sees the bounded result. Returns the resultId used
// and every response, so a caller can assert integrity (no stale/duplicate data).
export async function scanCycle(session, phoneJwt) {
  const resultId = uuid();
  const { requestId } = await sendCaptureRequest(session);
  const phoneSeesCapture = await phonePoll(session, phoneJwt, 0);
  const showRes = await sendResultShow(session, phoneJwt, resultId);
  const glassesSeesResult = await glassesPoll(session, 0);
  return { resultId, requestId, phoneSeesCapture, showRes, glassesSeesResult };
}
