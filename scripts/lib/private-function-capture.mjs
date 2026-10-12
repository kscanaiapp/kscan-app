import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * The child may report only fixed diagnostic labels; all other stderr is
 * untrusted and may contain Production function source or credentials.
 */
export function safeCaptureFailureCode(stderr) {
  const allowed = /Production capture download (server-api|legacy-local) failed \[(BUNDLE_FORMAT|LOCAL_UNBUNDLER|ACCESS_DENIED|RATE_LIMITED|TIMEOUT|NOT_FOUND|UNKNOWN)\]/g;
  const codes = [];
  for (const hit of String(stderr ?? '').matchAll(allowed)) {
    codes.push((hit[1] === 'server-api' ? 'API_' : 'LEGACY_') + hit[2]);
  }
  if (codes.length) return [...new Set(codes)].slice(0, 2).join('+');
  const stages = [...String(stderr ?? '').matchAll(/Production capture stage \[(ENVIRONMENT|TARGET_IDENTITY|CLI_LINK|LIVE_INVENTORY|LIVE_METADATA|ENTRYPOINT|DOWNLOAD_LAYOUT|CAPTURE_COPY|CAPTURE_DIGEST|CAPTURE_VERIFY|COMPLETE)\]/g)];
  return stages.length ? `STAGE_${stages.at(-1)[1]}` : 'STAGE_UNDETERMINED';
}

/** Explicitly pipe child stderr: Node otherwise re-emits it on execFileSync failure. */
export function runPrivateCapture(functionName, { env = process.env, exec = execFileSync } = {}) {
  try {
    const output = exec(process.execPath, [path.join('scripts', 'capture-production-function.mjs'),
      '--function', functionName], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output.slice(output.indexOf('{')));
  } catch (error) {
    const code = safeCaptureFailureCode(error?.stderr);
    throw new Error(`Private function capture failed [${code}]; credential-bearing CLI output withheld`);
  }
}
