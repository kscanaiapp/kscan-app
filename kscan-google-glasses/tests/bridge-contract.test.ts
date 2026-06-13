import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE_MESSAGE_TYPES = [
  'HELLO',
  'DEVICE_STATE',
  'REQUEST_PERMISSIONS',
  'PERMISSIONS_RESULT',
  'CAPTURE_PHOTO',
  'PHOTO_CAPTURED',
  'PHOTO_ERROR',
  'ANALYSIS_STARTED',
  'ANALYSIS_RESULT',
  'SAVE_ITEM',
  'OPEN_ON_PHONE',
  'AUTH_SESSION',
  'ERROR',
];

const schemaPath = join(__dirname, '../shared/bridge.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

describe('bridge contract', () => {
  it('schema enumerates all required message types', () => {
    const schemaTypes = schema.properties.type.enum as string[];
    for (const t of BRIDGE_MESSAGE_TYPES) {
      assert.ok(schemaTypes.includes(t), `missing schema type: ${t}`);
    }
  });

  it('schema defines HELLO conditional payload', () => {
    assert.ok(Array.isArray(schema.allOf));
  });
});
