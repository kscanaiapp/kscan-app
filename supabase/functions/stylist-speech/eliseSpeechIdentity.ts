import {
  ELISE_SPEECH_OPERATION_TYPE,
  type EliseSpeechErrorClass,
  type EliseSpeechOperation,
  type EliseSpeechOperationIdentity,
  type EliseSpeechOperationStatus,
} from './eliseSpeechTypes.ts';

/** Stable operation key — never uses raw speech text. */
export function buildSpeechOperationKey(identity: EliseSpeechOperationIdentity): string {
  return [
    identity.actorId,
    identity.sessionId,
    identity.messageId,
    identity.avatarId,
    identity.voiceProfile,
    identity.operationType,
  ].join(':');
}

export function createSpeechOperationIdentity(input: {
  actorId: string;
  sessionId: string;
  messageId: string;
  avatarId: string;
  voiceProfile: string;
}): EliseSpeechOperationIdentity {
  return {
    actorId: input.actorId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    avatarId: input.avatarId,
    voiceProfile: input.voiceProfile,
    operationType: ELISE_SPEECH_OPERATION_TYPE,
  };
}

/**
 * In-memory operation ledger for a single Edge isolate.
 * Durable cross-isolate ledger is intentionally omitted until product requires it.
 */
export class SpeechOperationRegistry {
  private readonly byKey = new Map<string, EliseSpeechOperation>();

  get(operationKey: string): EliseSpeechOperation | undefined {
    return this.byKey.get(operationKey);
  }

  reserve(input: {
    operationKey: string;
    actorId: string;
    sessionId: string;
    messageId: string;
    avatarId: string;
    voiceProfile: string;
    requestId: string;
    nowIso?: string;
  }): { created: boolean; operation: EliseSpeechOperation; duplicate: boolean } {
    const existing = this.byKey.get(input.operationKey);
    if (existing) {
      if (
        existing.status === 'reserved' ||
        existing.status === 'queued' ||
        existing.status === 'generating'
      ) {
        return {
          created: false,
          duplicate: true,
          operation: { ...existing, status: 'deduplicated' },
        };
      }
      if (existing.status === 'completed') {
        return { created: false, duplicate: true, operation: { ...existing } };
      }
      if (existing.status === 'failed_terminal' || existing.status === 'stale' || existing.status === 'cancelled') {
        // Terminal outcomes stay terminal — do not reopen.
        return { created: false, duplicate: true, operation: { ...existing } };
      }
      // failed_retryable may reopen with attempt++.
      const reopened: EliseSpeechOperation = {
        ...existing,
        status: 'reserved',
        attemptCount: existing.attemptCount + 1,
        stableErrorClass: null,
        completedAt: null,
        requestId: input.requestId,
      };
      this.byKey.set(input.operationKey, reopened);
      return { created: true, duplicate: false, operation: reopened };
    }

    const operation: EliseSpeechOperation = {
      operationId: crypto.randomUUID(),
      actorId: input.actorId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      avatarId: input.avatarId,
      voiceId: input.voiceProfile, // profile alias only — never provider voice secret
      requestId: input.requestId,
      status: 'reserved',
      attemptCount: 1,
      stableErrorClass: null,
      createdAt: input.nowIso ?? new Date().toISOString(),
      completedAt: null,
    };
    this.byKey.set(input.operationKey, operation);
    return { created: true, duplicate: false, operation };
  }

  markGenerating(operationKey: string): EliseSpeechOperation | null {
    const existing = this.byKey.get(operationKey);
    if (!existing) return null;
    if (existing.status === 'stale' || existing.status === 'cancelled') return existing;
    const next = { ...existing, status: 'generating' as const };
    this.byKey.set(operationKey, next);
    return next;
  }

  markStale(operationKey: string, errorClass: EliseSpeechErrorClass = 'OPERATION_STALE'): void {
    const existing = this.byKey.get(operationKey);
    if (!existing) return;
    this.byKey.set(operationKey, {
      ...existing,
      status: 'stale',
      stableErrorClass: errorClass,
      completedAt: new Date().toISOString(),
    });
  }

  finalize(
    operationKey: string,
    status: Extract<
      EliseSpeechOperationStatus,
      'completed' | 'failed_retryable' | 'failed_terminal' | 'cancelled' | 'stale'
    >,
    stableErrorClass: EliseSpeechErrorClass | null = null,
  ): EliseSpeechOperation | null {
    const existing = this.byKey.get(operationKey);
    if (!existing) return null;
    const next: EliseSpeechOperation = {
      ...existing,
      status,
      stableErrorClass,
      completedAt: new Date().toISOString(),
    };
    this.byKey.set(operationKey, next);
    return next;
  }

  /** Newer message supersedes older in-flight ops for the same actor/session/avatar. */
  supersedeOlderMessages(input: {
    actorId: string;
    sessionId: string;
    avatarId: string;
    keepMessageId: string;
  }): number {
    let count = 0;
    for (const [key, op] of this.byKey) {
      if (
        op.actorId === input.actorId &&
        op.sessionId === input.sessionId &&
        op.avatarId === input.avatarId &&
        op.messageId !== input.keepMessageId &&
        (op.status === 'reserved' || op.status === 'queued' || op.status === 'generating')
      ) {
        this.byKey.set(key, {
          ...op,
          status: 'stale',
          stableErrorClass: 'OPERATION_STALE',
          completedAt: new Date().toISOString(),
        });
        count += 1;
      }
    }
    return count;
  }

  resetForTests(): void {
    this.byKey.clear();
  }
}
