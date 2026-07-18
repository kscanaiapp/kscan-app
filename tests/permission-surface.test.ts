import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Static permission-surface contract for the Android glasses app.
// The main manifest must stay at zero permissions (see
// docs/google/PERMISSION_MATRIX.md); INTERNET exists only in the debug overlay.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_MANIFEST = join(__dirname, '../android-xr/app/src/main/AndroidManifest.xml');
const DEBUG_MANIFEST = join(__dirname, '../android-xr/app/src/debug/AndroidManifest.xml');

function permissionsIn(path: string): string[] {
  const src = readFileSync(path, 'utf8');
  return [...src.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]);
}

describe('manifest permission surface (static contract)', () => {
  it('main manifest declares no permissions at all', () => {
    assert.deepEqual(permissionsIn(MAIN_MANIFEST), []);
  });

  it('main manifest has no RECORD_AUDIO, CAMERA, VIBRATE or INTERNET', () => {
    const perms = permissionsIn(MAIN_MANIFEST);
    for (const p of ['RECORD_AUDIO', 'CAMERA', 'VIBRATE', 'INTERNET']) {
      assert.ok(
        !perms.some((declared) => declared.endsWith(p)),
        `${p} must not be declared in the main manifest`,
      );
    }
  });

  it('debug overlay declares INTERNET and nothing else', () => {
    assert.deepEqual(permissionsIn(DEBUG_MANIFEST), ['android.permission.INTERNET']);
  });

  it('debug overlay documents that INTERNET must never reach main', () => {
    const src = readFileSync(DEBUG_MANIFEST, 'utf8');
    assert.ok(src.includes('NEVER'), 'debug overlay must keep its never-promote warning');
  });
});
