/**
 * Report reason taxonomy for UGC moderation.
 *
 * These categories are used by the Report & Hide flow. They are sent to the
 * server-side content_reports table when an authenticated session exists.
 */
export const REPORT_REASON_CATEGORIES = [
  'inappropriate',
  'spam',
  'harassment',
  'offensive',
  'other',
] as const;

export type ReportReasonCategory = (typeof REPORT_REASON_CATEGORIES)[number];

const REASON_SET = new Set<string>(REPORT_REASON_CATEGORIES);

export function isValidReportReason(value: unknown): value is ReportReasonCategory {
  return typeof value === 'string' && REASON_SET.has(value);
}

/**
 * Target types that can be reported through the app.
 * The content_reports table accepts the same set.
 */
export const REPORT_TARGET_TYPES = [
  'room',
  'message',
  'reaction',
  'item',
  'image',
  'profile',
  'user',
] as const;

export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

const TARGET_TYPE_SET = new Set<string>(REPORT_TARGET_TYPES);

export function isValidReportTargetType(value: unknown): value is ReportTargetType {
  return typeof value === 'string' && TARGET_TYPE_SET.has(value);
}
