/**
 * Injectable connectivity port for the Closet candidate orchestrator.
 *
 * WHY THIS IS NOT NetInfo.
 *
 * The build instruction for connectivity is an ordered preference: reuse an
 * existing connectivity service, else an installed Expo-compatible network
 * package, else `@react-native-community/netinfo` ONLY when it is already
 * installed or a narrowly reviewed dependency addition is genuinely necessary.
 * Inspection of this worktree found:
 *
 *   - no existing connectivity service (services/ has only ad-hoc network-error
 *     string matching in styleChatErrors.ts)
 *   - `expo-network` NOT installed
 *   - `@react-native-community/netinfo` NOT installed
 *
 * Adding a native module is an owner-authorized change with its own lockfile,
 * Expo-compatibility and native-rebuild consequences, so this build does not make
 * one silently. What it does instead is define the SEAM, so that adding a real
 * reachability provider later is a single `setClosetConnectivityProvider` call at
 * app start and touches no orchestration code.
 *
 * THE DEFAULT PROVIDER IS REACTIVE, NOT PREDICTIVE. It assumes online — an
 * optimistic default costs one failed request, whereas a pessimistic one would
 * park every candidate in `waiting_for_network` on a perfectly good connection —
 * and it learns from failures: a request that fails with a transport-level
 * network error marks the port offline until something observes a success or the
 * app returns to the foreground.
 *
 * HONEST LIMITATION, recorded rather than papered over: without a reachability
 * API there is no push signal on reconnect. Recovery from `waiting_for_network`
 * is driven by app foreground, Closet screen focus, and the user's manual retry.
 */

/**
 * Transport-level network failure signatures.
 *
 * Matched against an ERROR MESSAGE, never against user-facing copy. The strings
 * below are the ones React Native's fetch and the Supabase client actually
 * produce; `styleChatErrors.ts` already classifies on the same two.
 */
const NETWORK_ERROR_SIGNATURES = [
  'network request failed',
  'networkerror',
  'failed to fetch',
  'connection refused',
  'unable to resolve host',
];

export function isNetworkErrorMessage(message) {
  if (typeof message !== 'string') return false;
  const normalized = message.toLowerCase();
  return NETWORK_ERROR_SIGNATURES.some((signature) => normalized.includes(signature));
}

/**
 * The port contract.
 *
 * `isOnline()` may be sync or async; the orchestrator always awaits it.
 * `noteFailure(error)` / `noteSuccess()` let the port learn from real traffic.
 */
function createDefaultProvider() {
  let believedOnline = true;
  return {
    kind: 'reactive-default',
    isOnline() {
      return believedOnline;
    },
    noteSuccess() {
      believedOnline = true;
    },
    noteFailure(error) {
      const message =
        typeof error === 'string' ? error : (error && error.message) || '';
      if (isNetworkErrorMessage(message)) believedOnline = false;
    },
    /** Called on app foreground / screen focus: re-optimism, then let traffic decide. */
    refresh() {
      believedOnline = true;
    },
  };
}

let provider = createDefaultProvider();

/**
 * Install a connectivity provider. The single integration point for a future
 * owner-approved reachability dependency.
 */
export function setClosetConnectivityProvider(next) {
  provider =
    next && typeof next.isOnline === 'function' ? next : createDefaultProvider();
}

export function resetClosetConnectivityProvider() {
  provider = createDefaultProvider();
}

/** Always awaited by callers so a provider may answer synchronously or not. */
export async function isClosetOnline() {
  try {
    return (await provider.isOnline()) !== false;
  } catch {
    // A provider that throws must not park every candidate offline. Fail toward
    // attempting the request; the request itself is the authoritative test.
    return true;
  }
}

export function noteClosetNetworkSuccess() {
  try {
    provider.noteSuccess?.();
  } catch {
    /* connectivity bookkeeping never propagates */
  }
}

export function noteClosetNetworkFailure(error) {
  try {
    provider.noteFailure?.(error);
  } catch {
    /* connectivity bookkeeping never propagates */
  }
}

/** Call on app foreground or Closet screen focus before a bounded requeue. */
export function refreshClosetConnectivity() {
  try {
    provider.refresh?.();
  } catch {
    /* connectivity bookkeeping never propagates */
  }
}

/** Test seam only. Not used by production code. */
export const __closetConnectivityInternals = {
  createDefaultProvider,
  NETWORK_ERROR_SIGNATURES,
  currentProviderKind: () => provider?.kind ?? 'custom',
};
