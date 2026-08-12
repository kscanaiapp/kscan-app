import { supabase } from './supabaseClient';
import {
  isValidReportReason,
  isValidReportTargetType,
  type ReportReasonCategory,
  type ReportTargetType,
} from '../constants/reportReasons';
import { isValidUuid } from './ugcSafetyStore';

export type ContentReportInput = {
  targetType: ReportTargetType;
  targetId: string;
  reasonCategory?: ReportReasonCategory;
  notes?: string | null;
  reportedUserId?: string | null;
  roomId?: string | null;
  /**
   * AI-output reports carry only a small allowlisted identifier context. The
   * database migration independently enforces this shape and prohibits it on
   * non-AI report targets.
   */
  aiOutputContext?: Record<string, string> | null;
};

export type ContentReportResult =
  | { ok: true; serverAccepted: true; duplicate: boolean }
  | { ok: true; serverAccepted: false; localOnly: true }
  | { ok: false; serverAccepted: false; error: Error };

const REPORT_ERROR_LOG_PREFIX = '[contentReports]';

function devLog(event: string, code?: string | number | null) {
  if (__DEV__) {
    console.warn(`${REPORT_ERROR_LOG_PREFIX} ${event}`, code ? { code } : undefined);
  }
}

function normalizeNotes(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * Submit a content report to the server-side content_reports table.
 *
 * Rules:
 * - Never accepts a caller-supplied reporter_user_id; the database default uses auth.uid().
 * - Gracefully degrades when the table does not exist yet, RLS rejects, network fails,
 *   or the user has no authenticated Supabase session. Local hide/block still applies.
 * - Treats a duplicate unique violation (23505) as success/idempotent.
 * - Does not throw; returns a result object the UI can consume safely.
 */
export async function submitContentReport(input: ContentReportInput): Promise<ContentReportResult> {
  if (!isValidReportTargetType(input.targetType)) {
    return { ok: false, serverAccepted: false, error: new Error('Invalid report target type.') };
  }
  if (!input.targetId || typeof input.targetId !== 'string') {
    return { ok: false, serverAccepted: false, error: new Error('Invalid report target id.') };
  }

  const reasonCategory: ReportReasonCategory = isValidReportReason(input.reasonCategory)
    ? input.reasonCategory
    : 'inappropriate';

  const notes = normalizeNotes(input.notes);

  const reportedUserId =
    input.reportedUserId && isValidUuid(input.reportedUserId) ? input.reportedUserId : null;

  const roomId = input.roomId && isValidUuid(input.roomId) ? input.roomId : null;
  const aiOutputContext = input.aiOutputContext ?? null;

  if (input.targetType === 'ai_output' && !aiOutputContext) {
    return { ok: false, serverAccepted: false, error: new Error('Invalid AI output report context.') };
  }

  if (input.targetType !== 'ai_output' && aiOutputContext) {
    return { ok: false, serverAccepted: false, error: new Error('AI output context is not valid for this report.') };
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;

  if (!session?.user?.id) {
    // Anonymous or unauthenticated users get local hide/block only.
    devLog('no authenticated session; report stored locally only');
    return { ok: true, serverAccepted: false, localOnly: true };
  }

  const row: Record<string, unknown> = {
    target_type: input.targetType,
    target_id: input.targetId,
    reason_category: reasonCategory,
  };

  if (notes) row.notes = notes;
  if (reportedUserId) row.reported_user_id = reportedUserId;
  if (roomId) row.room_id = roomId;
  if (aiOutputContext) row.ai_output_context = aiOutputContext;

  // Intentionally omit reporter_user_id so the database default (auth.uid()) binds it.
  try {
    const { error } = await supabase.from('content_reports').insert(row);

    if (error) {
      const pgCode = String(error.code ?? '');
      if (pgCode === '23505') {
        // Unique violation on (reporter_user_id, target_type, target_id) — already reported.
        devLog('duplicate report treated as success', pgCode);
        return { ok: true, serverAccepted: true, duplicate: true };
      }
      devLog('server insert failed', pgCode);
      return { ok: false, serverAccepted: false, error: new Error('Report could not be sent.') };
    }

    return { ok: true, serverAccepted: true, duplicate: false };
  } catch (err) {
    devLog('unexpected report error', err instanceof Error ? err.message : String(err));
    return { ok: false, serverAccepted: false, error: new Error('Report could not be sent.') };
  }
}
