import { submitContentReport, type ContentReportResult } from './contentReports';

export type AiOutputReportFeature = 'StyleChat' | 'TextScan' | 'Scan Results';

export type AiOutputReportRequest = {
  feature: AiOutputReportFeature;
  sessionId?: string | null;
  messageId?: string | null;
  itemId?: string | null;
};

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
  request: AiOutputReportRequest;
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

  const sessionId = normalizeIdentifier(input.request.sessionId);
  const messageId = normalizeIdentifier(input.request.messageId);
  const itemId = normalizeIdentifier(input.request.itemId);
  const targetId = messageId ?? itemId ?? sessionId;

  if (!targetId) {
    return { ok: false, serverAccepted: false, error: new Error('This AI response cannot be reported yet.') };
  }

  const aiOutputContext: Record<string, string> = {
    feature: input.request.feature,
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
