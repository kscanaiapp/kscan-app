/**
 * Narrow retry boundary for the Supabase CLI's Docker-based Edge Function
 * bundler. GitHub-hosted runners can be throttled by GHCR while pulling the
 * pinned edge-runtime image. That failure happens before any bundle upload,
 * so retrying the same argv is safe. Every other deploy failure remains
 * fail-fast.
 */

function failureText(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter((value) => typeof value === 'string' && value)
    .join('\n');
}

export function isTransientEdgeRuntimePullFailure(error) {
  const text = failureText(error);
  const namesEdgeRuntimePull =
    /ghcr\.io\/supabase\/edge-runtime/i.test(text) ||
    /pulling from supabase\/edge-runtime/i.test(text);
  const namesTransientThrottle =
    /too\s*many\s*requests|toomanyrequests/i.test(text) ||
    /error pulling image configuration/i.test(text) ||
    /download failed after attempts=\d+/i.test(text);
  const failedBeforeBundleUpload = /failed to bundle function:\s*exit 125/i.test(text);

  return namesEdgeRuntimePull && namesTransientThrottle && failedBeforeBundleUpload;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWithTransientEdgeRuntimePullRetry(
  run,
  {
    attempts = 4,
    baseDelayMs = 5_000,
    sleep = defaultSleep,
    onRetry = () => {},
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError('attempts must be a positive integer');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (!isTransientEdgeRuntimePullFailure(error) || attempt === attempts) {
        throw error;
      }

      const delayMs = baseDelayMs * attempt;
      onRetry({ attempt, nextAttempt: attempt + 1, attempts, delayMs });
      await sleep(delayMs);
    }
  }

  throw new Error('unreachable retry state');
}
