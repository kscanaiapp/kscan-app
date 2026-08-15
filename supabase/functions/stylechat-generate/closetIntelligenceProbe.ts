/** Staging-only switch for sanitized S7 live-probe evidence. */
export function isStagingClosetProbeRequest(
  headerValue: string | null,
  environment: string | undefined,
): boolean {
  return headerValue === '1' && environment?.trim().toLowerCase() === 'staging';
}

