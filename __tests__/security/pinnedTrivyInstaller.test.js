const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installer = import('../../security/scripts/install-pinned-trivy.mjs');

test('installer pins the same scanner version and official release integrity', async () => {
  const { RELEASE, requireSupportedRunner } = await installer;
  assert.equal(RELEASE.version, '0.70.0');
  assert.equal(new URL(RELEASE.url).hostname, 'github.com');
  assert.match(RELEASE.url, /\/v0\.70\.0\/trivy_0\.70\.0_Linux-64bit\.tar\.gz$/);
  assert.equal(RELEASE.sha256, '8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9');
  assert.ok(Object.isFrozen(RELEASE));
  requireSupportedRunner('linux', 'x64');
  assert.throws(() => requireSupportedRunner('linux', 'arm64'));
  assert.throws(() => requireSupportedRunner('win32', 'x64'));
});

test('empty, corrupted and unrelated archives fail the fixed checksum', async () => {
  const { verifyArchive } = await installer;
  for (const bytes of [Buffer.alloc(0), Buffer.from('corrupt gzip'), Buffer.from('untrusted executable')]) {
    assert.throws(() => verifyArchive(bytes), /checksum mismatch/);
  }
});

test('HTTP and integrity failures never extract or publish an executable PATH', async () => {
  const { installTrivy, RELEASE } = await installer;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-trivy-test-'));
  try {
    let calls = 0;
    for (const outcome of [500, 429, 'timeout', 'empty', 'corrupt']) {
      const githubPath = path.join(directory, 'github-path');
      await assert.rejects(installTrivy({ runnerTemp: directory, githubPath,
        execute() { calls++; throw new Error('Must not execute'); },
        fetchImpl: async url => {
          assert.equal(url, RELEASE.url);
          if (typeof outcome === 'number') return new Response(null, { status: outcome });
          if (outcome === 'timeout') throw new Error('synthetic timeout');
          return new Response(outcome === 'empty' ? '' : 'corrupt');
        },
      }));
      assert.equal(calls, 0);
      assert.equal(fs.existsSync(githubPath), false);
      assert.equal(fs.existsSync(path.join(directory, 'kscan-trivy-0.70.0')), false);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kscan-trivy-test-/);
    fs.rmdirSync(directory); // Failure fixtures must leave this directory empty.
  }
});

test('both governed scan formats still run with the original policy and verified installation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../.github/workflows/security-code.yml'), 'utf8');
  const job = source.slice(source.indexOf('\n  trivy:'), source.indexOf('\n  npm-audit:'));
  assert.match(job, /node security\/scripts\/install-pinned-trivy\.mjs/);
  assert.equal((job.match(/skip-setup-trivy: true/g) || []).length, 2);
  assert.equal((job.match(/version: v0\.70\.0/g) || []).length, 2);
  assert.equal((job.match(/scanners: vuln,secret,misconfig/g) || []).length, 2);
  assert.ok(job.indexOf('install-pinned-trivy.mjs') < job.indexOf('Run Trivy FS scan'));
  assert.match(job, /format: json/);
  assert.match(job, /format: table/);
  assert.match(job, /if-no-files-found: error/);
});
