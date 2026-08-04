#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeRateLimiter,
  analyzeRequestLog,
  ANALYZE_RATE_LIMIT_MAX_REQUESTS,
} = require('../../server.js');

// Minimal fakes -- no supertest/express app needed since analyzeRateLimiter
// is a plain (req, res, next) middleware function.
function fakeReq(ip) {
  return { ip, socket: {} };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
  return res;
}

test.beforeEach(() => {
  analyzeRequestLog.clear();
});

test('analyzeRateLimiter: allows requests under the limit', () => {
  const req = fakeReq('1.2.3.4');
  let nextCalled = 0;
  for (let i = 0; i < ANALYZE_RATE_LIMIT_MAX_REQUESTS; i++) {
    const res = fakeRes();
    analyzeRateLimiter(req, res, () => nextCalled++);
    assert.equal(res.statusCode, null, `request ${i + 1} should not be rejected`);
  }
  assert.equal(nextCalled, ANALYZE_RATE_LIMIT_MAX_REQUESTS);
});

test('analyzeRateLimiter: rejects the request that exceeds the limit with 429 and Retry-After', () => {
  const req = fakeReq('5.6.7.8');
  for (let i = 0; i < ANALYZE_RATE_LIMIT_MAX_REQUESTS; i++) {
    analyzeRateLimiter(req, fakeRes(), () => {});
  }
  const res = fakeRes();
  let nextCalled = false;
  analyzeRateLimiter(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'RATE_LIMITED');
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('analyzeRateLimiter: never reveals internal thresholds or provider details in the rejection body', () => {
  const req = fakeReq('9.9.9.9');
  for (let i = 0; i < ANALYZE_RATE_LIMIT_MAX_REQUESTS; i++) {
    analyzeRateLimiter(req, fakeRes(), () => {});
  }
  const res = fakeRes();
  analyzeRateLimiter(req, res, () => {});
  const bodyText = JSON.stringify(res.body);
  assert.doesNotMatch(bodyText, /gemini|openrouter/i);
});

test('analyzeRateLimiter: tracks distinct IPs independently', () => {
  const ipA = fakeReq('10.0.0.1');
  const ipB = fakeReq('10.0.0.2');

  for (let i = 0; i < ANALYZE_RATE_LIMIT_MAX_REQUESTS; i++) {
    analyzeRateLimiter(ipA, fakeRes(), () => {});
  }
  // ipA is now at the limit; ipB should be unaffected.
  const resB = fakeRes();
  let nextCalledB = false;
  analyzeRateLimiter(ipB, resB, () => {
    nextCalledB = true;
  });
  assert.equal(nextCalledB, true);
  assert.equal(resB.statusCode, null);

  const resA = fakeRes();
  analyzeRateLimiter(ipA, resA, () => {});
  assert.equal(resA.statusCode, 429);
});
