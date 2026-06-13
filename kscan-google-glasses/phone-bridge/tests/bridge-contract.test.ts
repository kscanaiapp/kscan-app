import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BRIDGE_MESSAGE_TYPES } from '../src/BridgeMessageTypes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '../../shared/bridge.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

describe('bridge contract', () => {
  it('schema enumerates all required message types', () => {
    const schemaTypes = schema.properties.type.enum as string[];
    for (const t of BRIDGE_MESSAGE_TYPES) {
      assert.ok(schemaTypes.includes(t), `missing schema type: ${t}`);
    }
  });

  it('HELLO payload requires client and version', () => {
    assert.ok(Array.isArray(schema.allOf));
  });
});
