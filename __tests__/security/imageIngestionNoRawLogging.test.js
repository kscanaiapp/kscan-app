#!/usr/bin/env node
'use strict';

// Static source scan: no ingestion-gate/scan-worker module (or their
// server.js integration point) may log raw image bytes, base64 payloads, or
// full scanner output. This mirrors the "required operational behavior"
// section -- these are things that must never appear in logs, checked the
// same way rls-storage-guard checks structural facts about the codebase
// rather than runtime behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES_TO_SCAN = [
  'security/ingestion-gate/gate.js',
  'security/ingestion-gate/reencode.js',
  'security/ingestion-gate/clamdClient.js',
  'security/ingestion-gate/verdict.js',
  'security/scan-worker/scanQuarantineObject.js',
  'server.js',
];

// Patterns that would indicate raw image content, full base64 payloads, or
// unredacted scanner detail reaching a log line.
const SUSPICIOUS_PATTERNS = [
  /console\.\w+\([^)]*\bdata\.toString\(['"]base64['"]\)/,
  /console\.\w+\([^)]*canonicalBuffer/,
  /console\.\w+\([^)]*\.toString\(['"]base64['"]\)/,
  /console\.\w+\([^)]*signatureName/, // malware family name must never be logged to a user-facing path
];

test('no ingestion-gate/scan-worker source file logs raw image bytes or base64 payloads', () => {
  for (const relPath of FILES_TO_SCAN) {
    const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    for (const pattern of SUSPICIOUS_PATTERNS) {
      assert.equal(pattern.test(source), false, `${relPath} matched suspicious logging pattern ${pattern}`);
    }
  }
});

test('verdict.js userFacingMessage never interpolates scanner-internal fields', () => {
  const source = fs.readFileSync(path.join(ROOT, 'security/ingestion-gate/verdict.js'), 'utf8');
  const messagesBlock = source.match(/const USER_FACING_MESSAGES = Object\.freeze\(\{[\s\S]*?\}\);/)[0];
  assert.equal(/\$\{/.test(messagesBlock), false, 'USER_FACING_MESSAGES must be static strings, never template interpolation');
});

test('clamdClient.js scan verdict never embeds signatureName in a message shown to end users', () => {
  const source = fs.readFileSync(path.join(ROOT, 'security/ingestion-gate/clamdClient.js'), 'utf8');
  // signatureName is captured for internal/ops use; assert it's confined to
  // the internal `reason`/`signatureName` fields, never assigned into
  // anything named like a user-facing message.
  assert.equal(/userMessage[\s\S]{0,80}signatureName/.test(source), false);
});

test('gate.js: userMessage is only ever derived from userFacingMessage(verdictCode), never from scanResult.reason directly', () => {
  const source = fs.readFileSync(path.join(ROOT, 'security/ingestion-gate/gate.js'), 'utf8');
  // The reject() helper is the ONLY place userMessage is assigned in this
  // file, and it always derives it from the verdict code via
  // userFacingMessage() -- assert there is no second, separate assignment
  // of `userMessage:` anywhere that could bypass that mapping.
  const userMessageAssignments = source.match(/userMessage:\s*[^,}\n]+/g) || [];
  assert.equal(userMessageAssignments.length, 1, `expected exactly one userMessage: assignment, found ${userMessageAssignments.length}`);
  assert.match(userMessageAssignments[0], /userFacingMessage\(verdictCode\)/);
});

test('gate.js verdict-rejection call sites never pass raw scanner internals as the second (internalReason) argument to a user-visible field', () => {
  const source = fs.readFileSync(path.join(ROOT, 'security/ingestion-gate/gate.js'), 'utf8');
  // internalReason is a distinct field from userMessage in the reject()
  // return shape -- confirm reject()'s object literal never merges the two.
  const rejectFn = source.match(/function reject\([\s\S]*?\n\}/)[0];
  assert.match(rejectFn, /internalReason/);
  assert.match(rejectFn, /userMessage: userFacingMessage\(verdictCode\)/);
});
