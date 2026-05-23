const MIN_INTERVAL_MS = 200;
const lastCall    = new Map<string, number>();
const backedOff   = new Map<string, number>();

// Call after receiving a 429 — suppresses the provider for 30 s.
export function markRateLimited(provider: string): void {
  backedOff.set(provider, Date.now() + 30_000);
}

export function isBackedOff(provider: string): boolean {
  const until = backedOff.get(provider) ?? 0;
  return Date.now() < until;
}

// Enforces min 200 ms between calls per provider.
// Returns `fallback` immediately if the provider is in backoff.
export async function throttleProvider<T>(
  provider: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (isBackedOff(provider)) return fallback;

  const now  = Date.now();
  const last = lastCall.get(provider) ?? 0;
  const wait = MIN_INTERVAL_MS - (now - last);
  if (wait > 0) {
    await new Promise<void>(r => setTimeout(r, wait));
  }
  lastCall.set(provider, Date.now());
  return fn();
}
