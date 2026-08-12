import { buildObservabilityContext, emitObservabilityEvent } from '../../services/observability';

export function logError(
  label: string,
  error: unknown,
  extra?: unknown
): void {
  const errorCategory = error instanceof Error ? error.name : 'unknown_error';
  const safeContext = buildObservabilityContext({
    operation: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80),
    error_category: errorCategory,
  });
  console.error(`[K Scan] ${label}`, safeContext);
  emitObservabilityEvent('mobile.error', safeContext);

  if (extra !== undefined) {
    const safeExtra = extra && typeof extra === 'object'
      ? buildObservabilityContext(extra as Record<string, unknown>)
      : {};
    console.error(`[K Scan] ${label} extra`, safeExtra);
  }
}
