/**
 * CI-03 harness: the StyleChat generation-path inventory and its mapping onto validator origins.
 *
 * Every branch of stylechat-generate/index.ts that can put model text in front of a customer is listed with the source
 * marker that identifies it and the `GenerationOrigin` CI-04 must pass to `finalizeCorporateResponse`. A test scans
 * index.ts (read-only text; nothing is imported from the function) so a new or renamed path fails until it is mapped.
 * This module is data only -- it wires nothing.
 */
import type { GenerationOrigin } from '../outputValidation.ts';

export interface StyleChatGenerationPath {
  id: string;
  /** Literal source text in stylechat-generate/index.ts that marks this path. */
  sourceMarker: string;
  /** The validator origin CI-04 must use, or null when the path emits deterministic legacy copy (no model text). */
  origin: GenerationOrigin | null;
  description: string;
}

export const STYLECHAT_GENERATION_PATHS: readonly StyleChatGenerationPath[] = Object.freeze([
  {
    id: 'initial',
    sourceMarker: "callGeminiWithOptionalRetry(geminiBody, 'initial')",
    origin: 'primary_initial',
    description: 'First generation for the turn.',
  },
  {
    id: 'provider_retry',
    sourceMarker: '`${attemptLabel}-provider-retry`',
    origin: 'primary_provider_retry',
    description: 'One provider-error retry inside callGeminiWithOptionalRetry (same model, same body).',
  },
  {
    id: 'completeness_retry',
    sourceMarker: "callGemini(geminiUrl, retryBody, 'retry', modelName)",
    origin: 'completeness_retry',
    description: 'Same-model retry after the completeness heuristic flags the initial reply.',
  },
  {
    id: 'best_effort_after_retry',
    sourceMarker: 'returned_best_effort_after_retry',
    origin: 'best_effort_after_retry',
    description: 'Retry text kept although the heuristic still flags it (not MAX_TOKENS).',
  },
  {
    id: 'best_effort_initial_after_retry_failure',
    sourceMarker: 'returned_best_effort_initial_after_retry_failure',
    origin: 'best_effort_initial_after_retry_failure',
    description: 'Initial text kept after the completeness retry threw.',
  },
  {
    id: 'legacy_deterministic_fallback',
    sourceMarker: 'buildStyleChatFallback()',
    origin: null,
    description: 'Existing deterministic StyleChat copy (no model text). Must itself pass the validator.',
  },
]);

/**
 * Not present in index.ts today (finding F1: `fallbackModelName` is configured but never invoked). Listed so that a
 * future provider fallback has a mapped origin and is validated identically by construction.
 */
export const FUTURE_FALLBACK_MODEL_ORIGIN: GenerationOrigin = 'fallback_model';
