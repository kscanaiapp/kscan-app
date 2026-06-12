const assert = require('node:assert/strict');
const test = require('node:test');

const { appendNote, parseArgs } = require('../scripts/process-deletion-request');

test('parseArgs: request deletion is dry-run by default', () => {
  assert.deepEqual(parseArgs(['--request-id', 'req-1']), {
    confirmDelete: false,
    dryRun: true,
    help: false,
    json: false,
    listPending: false,
    limit: 20,
    outputDir: null,
    requestId: 'req-1',
    userId: null,
  });
});

test('parseArgs: confirm-delete opts into destructive processing', () => {
  const options = parseArgs(['--user-id', 'user-1', '--confirm-delete', '--output-dir', 'qa/deletions']);

  assert.equal(options.confirmDelete, true);
  assert.equal(options.dryRun, false);
  assert.equal(options.userId, 'user-1');
  assert.equal(options.outputDir, 'qa/deletions');
});

test('parseArgs: requires exactly one selector', () => {
  assert.throws(() => parseArgs([]), /Choose exactly one selector/);
  assert.throws(
    () => parseArgs(['--list-pending', '--request-id', 'req-1']),
    /Choose exactly one selector/,
  );
});

test('parseArgs: validates limit range', () => {
  assert.throws(() => parseArgs(['--list-pending', '--limit', '0']), /between 1 and 100/);
  assert.equal(parseArgs(['--list-pending', '--limit', '5']).limit, 5);
});

test('appendNote appends on a new line without losing existing notes', () => {
  assert.equal(appendNote('', 'started'), 'started');
  assert.equal(appendNote('existing', 'started'), 'existing\nstarted');
  assert.equal(appendNote(' existing ', 'started'), 'existing\nstarted');
});
