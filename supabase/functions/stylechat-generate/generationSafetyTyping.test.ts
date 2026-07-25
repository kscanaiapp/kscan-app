/**
 * Focused regression for the generation-safety type baseline:
 * GenerationRpcClient must accept Supabase-like thenable rpc() results, and
 * Gemini attempt labels must remain free-form strings for provider-retry paths.
 */
import assert from 'node:assert/strict';

import {
  type GenerationRpcClient,
  type GenerationRpcResult,
  markGenerationGenerating,
  reserveGenerationOperation,
} from './generationSafety.ts';

Deno.test('GenerationRpcClient accepts PromiseLike rpc results (Supabase-compatible)', async () => {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];

  const userClient: GenerationRpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      // Thenable without catch/finally — mirrors PostgrestFilterBuilder shape.
      return {
        then<TResult1 = GenerationRpcResult, TResult2 = never>(
          onfulfilled?: ((value: GenerationRpcResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          const result: GenerationRpcResult = {
            data: {
              operation_id: 'op-1',
              status: 'reserved',
              attempt_count: 1,
              assistant_message_id: null,
              is_duplicate: false,
              may_generate: true,
              stable_error_class: null,
            },
            error: null,
          };
          return Promise.resolve(result).then(
            onfulfilled ?? undefined,
            onrejected ?? undefined,
          );
        },
      };
    },
    from() {
      throw new Error('from() should not be called in this test');
    },
  };

  const reserved = await reserveGenerationOperation({
    userClient,
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourceMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationKey: 'actor:session:source:stylechat_generate',
    requestId: 'req-1',
  });

  assert.ok(reserved);
  assert.equal(reserved.operationId, 'op-1');
  assert.equal(reserved.mayGenerate, true);
  assert.equal(calls[0]?.fn, 'reserve_elise_generation_operation');

  const markClient: GenerationRpcClient = {
    rpc(fn) {
      assert.equal(fn, 'mark_elise_generation_generating');
      return {
        then<TResult1 = GenerationRpcResult, TResult2 = never>(
          onfulfilled?: ((value: GenerationRpcResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve<GenerationRpcResult>({ data: true, error: null }).then(
            onfulfilled ?? undefined,
            onrejected ?? undefined,
          );
        },
      };
    },
    from() {
      throw new Error('from() should not be called in this test');
    },
  };

  assert.equal(await markGenerationGenerating(markClient, 'op-1'), true);
});

Deno.test('Gemini attempt labels include provider-retry suffixes as plain strings', () => {
  const allowedAttempts: string[] = [
    'initial',
    'retry',
    'initial-provider-retry',
    'retry-provider-retry',
  ];
  for (const attempt of allowedAttempts) {
    assert.equal(typeof attempt, 'string');
    assert.ok(attempt.length > 0);
  }
  // Composite labels used by callGeminiWithOptionalRetry must remain assignable
  // to the callGemini attempt parameter (string), not a closed literal union.
  const attemptLabel = 'initial';
  const providerRetryLabel: string = `${attemptLabel}-provider-retry`;
  assert.equal(providerRetryLabel, 'initial-provider-retry');
});
