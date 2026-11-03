// Same scanner as the governed action; avoid its unavailable get.trivy.dev installer.
// Official checksum: https://github.com/aquasecurity/trivy/releases/tag/v0.70.0
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const RELEASE = Object.freeze({
  version: '0.70.0',
  url: 'https://github.com/aquasecurity/trivy/releases/download/v0.70.0/trivy_0.70.0_Linux-64bit.tar.gz',
  sha256: '8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9',
});
const MAX_BYTES = 128 * 1024 * 1024;

export function verifyArchive(bytes) {
  if (!bytes.length || bytes.length > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== RELEASE.sha256) {
    throw new Error('Pinned Trivy archive checksum mismatch');
  }
}

export function requireSupportedRunner(platform, arch) {
  if (platform !== 'linux' || arch !== 'x64') throw new Error('Pinned Trivy requires Linux x64');
}

export async function installTrivy({ runnerTemp, githubPath, fetchImpl = fetch, execute = execFileSync }) {
  if (!runnerTemp || !githubPath) throw new Error('Runner temporary directory and PATH file required');
  const response = await fetchImpl(RELEASE.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Trivy archive download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('Trivy archive body missing');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Trivy archive exceeds size bound');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  verifyArchive(bytes); // Always before filesystem publication or executable extraction.
  const directory = join(runnerTemp, 'kscan-trivy-0.70.0');
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, 'verified-trivy.tar.gz');
  writeFileSync(archive, bytes);
  execute('tar', ['-xzf', archive, '-C', directory, 'trivy'], { stdio: 'pipe' });
  const binary = join(directory, 'trivy');
  const version = execute(binary, ['--version'], { encoding: 'utf8' });
  if (!/^Version:\s*0\.70\.0\s*$/m.test(version)) throw new Error('Installed Trivy version mismatch');
  appendFileSync(githubPath, directory + '\n');
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireSupportedRunner(process.platform, process.arch);
    await installTrivy({ runnerTemp: process.env.RUNNER_TEMP, githubPath: process.env.GITHUB_PATH });
    console.log('Verified Trivy 0.70.0 installed; existing scans remain required.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
