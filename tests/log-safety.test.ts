import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Static log-safety contract for the Android glasses app main sources.
// Complements the JVM unit tests (config/SafeLogTest.kt): this file scans the
// actual source tree so no future change can bypass the SafeLog wrapper.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = join(__dirname, '../android-xr/app/src/main/java/com/kscan/glasses');
const SAFE_LOG = join('config', 'SafeLog.kt');

function walkKotlin(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkKotlin(full));
    else if (entry.isFile() && entry.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

const ktFiles = walkKotlin(MAIN_SRC);

describe('log safety (static contract)', () => {
  it('scans the main Kotlin source tree', () => {
    assert.ok(ktFiles.length > 10, `expected main sources under ${MAIN_SRC}`);
  });

  it('no direct android.util.Log usage outside config/SafeLog.kt', () => {
    for (const file of ktFiles) {
      if (file.endsWith(SAFE_LOG)) continue;
      const src = readFileSync(file, 'utf8');
      assert.ok(
        !src.includes('android.util.Log'),
        `android.util.Log referenced in ${relative(MAIN_SRC, file)} — route through SafeLog`,
      );
    }
  });

  it('no println, printStackTrace, System.err or System.out anywhere in main sources', () => {
    const banned = ['println(', 'printStackTrace', 'System.err', 'System.out'];
    for (const file of ktFiles) {
      const src = readFileSync(file, 'utf8');
      for (const token of banned) {
        assert.ok(
          !src.includes(token),
          `${token} found in ${relative(MAIN_SRC, file)} — unsafe console/stack-trace output`,
        );
      }
    }
  });

  it('SafeLog never passes a raw Throwable to a Log overload', () => {
    const src = readFileSync(join(MAIN_SRC, SAFE_LOG), 'utf8');
    assert.ok(
      !/Log\.[a-z]\([^)]*throwable/i.test(src),
      'raw Throwable passed to android.util.Log — log describeThrowable(t) class name only',
    );
  });
});

describe('stable scan error codes (static contract)', () => {
  const EXPECTED_CODES = [
    'CAPTURE_UNAVAILABLE',
    'PRIVACY_UNAVAILABLE',
    'PRIVACY_BLOCKED',
    'IMAGE_DECODE_FAILED',
    'IMAGE_ENCODE_FAILED',
    'PAYLOAD_INVALID',
    'CONFIGURATION_REQUIRED',
    'BACKEND_UNAVAILABLE',
    'BACKEND_TIMEOUT',
    'CANCELLED',
    'NON_FASHION',
    'UNKNOWN_SAFE_ERROR',
  ];

  it('ScanErrorCode enumerates the stable code set', () => {
    const src = readFileSync(join(MAIN_SRC, 'scan', 'ScanErrorCode.kt'), 'utf8');
    for (const code of EXPECTED_CODES) {
      assert.ok(new RegExp(`\\b${code}\\b`).test(src), `missing ScanErrorCode.${code}`);
    }
  });

  it('every orchestrator error exposes a stable code', () => {
    const src = readFileSync(join(MAIN_SRC, 'scan', 'ScanOrchestrator.kt'), 'utf8');
    assert.ok(
      src.includes('abstract val code: ScanErrorCode'),
      'ScanOrchestratorError must declare abstract val code: ScanErrorCode',
    );
  });
});
