import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMockGlassesSession,
  analyzeMockGlassesCapture,
  getMockGlassesResult,
  getMockLowConfidenceResult,
  getMockErrorOutcome,
} from '../../services/glasses/mockGlassesService';

describe('mockGlassesService', () => {
  describe('createMockGlassesSession', () => {
    it('returns a session with expected shape', () => {
      const session = createMockGlassesSession('mock-camera');
      assert.ok(session.sessionId);
      assert.equal(typeof session.sessionId, 'string');
      assert.ok(session.sessionId.startsWith('mock-session-'));
      assert.equal(session.captureMode, 'mock-camera');
      assert.equal(session.captureCount, 0);
      assert.equal(typeof session.createdAt, 'string');
    });

    it('defaults captureMode to mock-camera', () => {
      const session = createMockGlassesSession();
      assert.equal(session.captureMode, 'mock-camera');
    });
  });

  describe('analyzeMockGlassesCapture', () => {
    it('returns a successful deterministic result for valid input', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome = await analyzeMockGlassesCapture(session, 'test-trigger-1');
      assert.equal(outcome.success, true);
      if (!outcome.success) return;
      assert.equal(outcome.result.isMockOnly, true);
      assert.ok(outcome.result.confidence > 0);
      assert.ok(outcome.result.confidence <= 1);
      assert.equal(typeof outcome.result.title, 'string');
      assert.equal(typeof outcome.result.summary, 'string');
      assert.ok(outcome.result.items.length > 0);
    });

    it('returns the same deterministic result for the same triggerId', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome1 = await analyzeMockGlassesCapture(session, 'same-id');
      const outcome2 = await analyzeMockGlassesCapture(session, 'same-id');
      assert.equal(outcome1.success, true);
      assert.equal(outcome2.success, true);
      if (!outcome1.success || !outcome2.success) return;
      assert.equal(outcome1.result.title, outcome2.result.title);
      assert.equal(outcome1.result.confidence, outcome2.result.confidence);
    });

    it('returns a low-confidence result when triggerId maps to low confidence', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome = await analyzeMockGlassesCapture(session, 'ab');
      assert.equal(outcome.success, true);
      if (!outcome.success) return;
      assert.ok(outcome.result.confidenceLevel);
    });

    it('returns an error for empty input', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome = await analyzeMockGlassesCapture(session, '');
      assert.equal(outcome.success, false);
      if (outcome.success) return;
      assert.equal(outcome.error.code, 'MOCK_INVALID_INPUT');
      assert.equal(outcome.error.recoverable, true);
    });

    it('returns an error for whitespace-only input', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome = await analyzeMockGlassesCapture(session, '   ');
      assert.equal(outcome.success, false);
      if (outcome.success) return;
      assert.equal(outcome.error.code, 'MOCK_INVALID_INPUT');
    });

    it('does not throw for valid input', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome = await analyzeMockGlassesCapture(session, 'safe-trigger');
      assert.ok(outcome);
    });

    it('does not throw for empty input', async () => {
      const session = createMockGlassesSession('mock-camera');
      const outcome = await analyzeMockGlassesCapture(session, '');
      assert.ok(outcome);
    });
  });

  describe('getMockGlassesResult', () => {
    it('returns a pre-canned result with high confidence', () => {
      const result = getMockGlassesResult();
      assert.equal(result.isMockOnly, true);
      assert.ok(result.confidence > 0.8);
      assert.equal(result.confidenceLevel, 'high');
      assert.ok(result.items.length > 0);
      assert.equal(typeof result.recommendation, 'string');
    });
  });

  describe('getMockLowConfidenceResult', () => {
    it('returns a result with low confidence level', () => {
      const result = getMockLowConfidenceResult();
      assert.equal(result.isMockOnly, true);
      assert.equal(result.confidenceLevel, 'low');
      assert.ok(result.confidence < 0.5);
    });
  });

  describe('getMockErrorOutcome', () => {
    it('returns a failed outcome with error details', () => {
      const outcome = getMockErrorOutcome();
      assert.equal(outcome.success, false);
      if (outcome.success) return;
      assert.equal(outcome.error.code, 'MOCK_ERROR_FORCED');
      assert.equal(outcome.error.recoverable, true);
    });
  });
});
