import { submitContentReport, type ContentReportResult } from './contentReports';
import {
  captureActorScope,
  currentActorId,
  isActorScopeCurrent,
  type ActorScope,
} from './actorScope';

export type AiOutputReportFeature = 'StyleChat' | 'TextScan' | 'Scan Results';

export type AiOutputReportRequest = {
  feature: AiOutputReportFeature;
  sessionId?: string | null;
  messageId?: string | null;
  itemId?: string | null;
};

/**
 * An open AI-output report, bound to the actor generation that opened it.
 *
 * ELISE-001. AiOutputReportProvider is mounted above the navigator, so an open
 * report sheet outlives a sign-out / account switch. The request itself names a
 * private session id and message id belonging to whoever opened it, and
 * reporter_user_id is bound server-side by auth.uid() — so an unbound request
 * lets the ARRIVING actor file a report against the DEPARTED actor's private
 * Elise message.
 *
 * The epoch (not the actor id) is the discriminator: an A -> B -> A cycle
 * returns the same id and must still be rejected.
 */
export type BoundAiOutputReportRequest = {
  readonly request: AiOutputReportRequest;
  readonly actorScope: ActorScope;
  readonly actorId: string | null;
};

/** Capture the live actor generation for a report the user is about to compose. */
export function bindAiOutputReportRequest(
  request: AiOutputReportRequest,
): BoundAiOutputReportRequest {
  return {
    request,
    actorScope: captureActorScope(),
    actorId: currentActorId(),
  };
}

/** True only while the binding still names the live actor generation. */
export function isBoundAiOutputReportCurrent(
  bound: BoundAiOutputReportRequest | null | undefined,
): boolean {
  return Boolean(bound) && isActorScopeCurrent(bound!.actorScope);
}

function isBoundRequest(
  value: AiOutputReportRequest | BoundAiOutputReportRequest,
): value is BoundAiOutputReportRequest {
  return (
    value != null &&
    typeof value === 'object' &&
    'request' in value &&
    'actorScope' in value
  );
}

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_COMMENT_LENGTH = 1000;

export const AI_OUTPUT_REPORT_REASONS = [
  {
    id: 'offensive_or_inappropriate',
    label: 'Offensive or inappropriate',
    reasonCategory: 'offensive',
  },
  {
    id: 'harmful_or_unsafe',
    label: 'Harmful or unsafe',
    reasonCategory: 'inappropriate',
  },
  {
    id: 'incorrect_or_misleading',
    label: 'Incorrect or misleading',
    reasonCategory: 'other',
  },
  {
    id: 'biased',
    label: 'Biased',
    reasonCategory: 'other',
  },
  {
    id: 'other',
    label: 'Other',
    reasonCategory: 'other',
  },
] as const;

export type AiOutputReportReasonId = (typeof AI_OUTPUT_REPORT_REASONS)[number]['id'];

export type AiOutputReportSubmissionInput = {
  /**
   * Prefer a BoundAiOutputReportRequest from bindAiOutputReportRequest(). A
   * plain request is still accepted and is bound HERE, at submit time, so a
   * caller that has not adopted the binding is never worse off than before —
   * but it cannot detect an actor change that happened while the sheet was open.
   */
  request: AiOutputReportRequest | BoundAiOutputReportRequest;
  reasonId: AiOutputReportReasonId;
  notes?: string | null;
};

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_IDENTIFIER_LENGTH ? normalized : null;
}

function normalizeNotes(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, MAX_COMMENT_LENGTH) : null;
}

function findReason(reasonId: AiOutputReportReasonId) {
  return AI_OUTPUT_REPORT_REASONS.find((reason) => reason.id === reasonId) ?? null;
}

/**
 * Submit a report against a genuine AI-output target. The context deliberately
 * contains only stable identifiers; raw response text and scan media are never
 * attached to this report path.
 */
export async function submitAiOutputReport(
  input: AiOutputReportSubmissionInput,
): Promise<ContentReportResult> {
  const reason = findReason(input.reasonId);
  if (!reason) {
    return { ok: false, serverAccepted: false, error: new Error('Invalid AI output report reason.') };
  }

  const bound = isBoundRequest(input.request)
    ? input.request
    : bindAiOutputReportRequest(input.request);

  // Gate BEFORE building anything: a stale binding means these identifiers
  // belong to a different actor's private conversation.
  if (!isBoundAiOutputReportCurrent(bound)) {
    return {
      ok: false,
      serverAccepted: false,
      error: new Error('The signed-in account changed. Please open this report again.'),
    };
  }

  const request = bound.request;
  const sessionId = normalizeIdentifier(request.sessionId);
  const messageId = normalizeIdentifier(request.messageId);
  const itemId = normalizeIdentifier(request.itemId);
  const targetId = messageId ?? itemId ?? sessionId;

  if (!targetId) {
    return { ok: false, serverAccepted: false, error: new Error('This AI response cannot be reported yet.') };
  }

  const aiOutputContext: Record<string, string> = {
    feature: request.feature,
    reason_detail: reason.id,
  };
  if (sessionId) aiOutputContext.session_id = sessionId;
  if (messageId) aiOutputContext.message_id = messageId;
  if (itemId) aiOutputContext.item_id = itemId;

  return submitContentReport({
    targetType: 'ai_output',
    targetId,
    reasonCategory: reason.reasonCategory,
    notes: normalizeNotes(input.notes),
    aiOutputContext,
    // Re-checked against the LIVE session at insert time. The epoch gate above
    // cannot see an actor change that lands during this call.
    expectedActorId: bound.actorId,
  });
}

/**
 * A synchronous guard closes the gap before React has applied a disabled state,
 * so two rapid taps cannot create two in-flight report submissions.
 */
export function createAiOutputReportSubmissionGate() {
  let inFlight = false;

  return {
    async run<T>(submit: () => Promise<T>): Promise<{ started: true; value: T } | { started: false }> {
      if (inFlight) return { started: false };
      inFlight = true;
      try {
        return { started: true, value: await submit() };
      } finally {
        inFlight = false;
      }
    },
  };
}
