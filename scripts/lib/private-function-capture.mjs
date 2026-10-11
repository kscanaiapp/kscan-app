import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Explicitly pipe child stderr: Node otherwise re-emits it on execFileSync failure. */
export function runPrivateCapture(functionName, { env = process.env, exec = execFileSync } = {}) {
  try {
    const output = exec(process.execPath, [path.join('scripts', 'capture-production-function.mjs'),
      '--function', functionName], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output.slice(output.indexOf('{')));
  } catch { throw new Error('Private function capture failed; credential-bearing CLI output withheld'); }
}
