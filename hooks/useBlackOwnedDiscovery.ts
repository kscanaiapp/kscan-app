import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { requestBlackOwnedDiscovery, type SecondaryInput, type SecondaryResponse } from '../services/blackOwnedDiscovery';

type Invoke = Parameters<typeof requestBlackOwnedDiscovery>[0];

const defaultInvoke: Invoke = (name, options) =>
  supabase.functions.invoke(name, { body: options.body, signal: options.signal }) as Promise<{ data: unknown; error: unknown }>;

/**
 * Secondary discovery for the live scan result.
 *
 * Starts only when `primarySettled` is true, so primary commerce always renders
 * first and is never awaited by this request. A new request key (a different
 * scan or primary set) or unmount aborts the in-flight request; a superseded
 * response is discarded. Any failure leaves the result undefined, which hides
 * the shelf and every badge without touching primary cards.
 */
export function useBlackOwnedDiscovery(
  input: SecondaryInput | null,
  requestKey: string | null,
  options: { enabled: boolean; primarySettled: boolean; invoke?: Invoke },
): SecondaryResponse | undefined {
  const [state, setState] = useState<{ key: string | null; response: SecondaryResponse | undefined }>({ key: null, response: undefined });
  const active = options.enabled && options.primarySettled && Boolean(input) && Boolean(requestKey);
  const invoke = options.invoke ?? defaultInvoke;

  useEffect(() => {
    if (!active || !input) return undefined;
    const controller = new AbortController();
    void requestBlackOwnedDiscovery(invoke, input, { enabled: true, primarySettled: true, signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setState({ key: requestKey, response });
      });
    return () => controller.abort();
    // requestKey is the identity of `input`; re-running on the object would refetch every render.
  }, [active, requestKey]);

  return active && state.key === requestKey ? state.response : undefined;
}
