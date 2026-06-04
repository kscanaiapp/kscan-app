export function logError(
  label: string,
  error: unknown,
  extra?: unknown
): void {
  console.error(`[K Scan] ${label}`, error);

  if (extra !== undefined) {
    console.error(`[K Scan] ${label} extra`, extra);
  }
}
