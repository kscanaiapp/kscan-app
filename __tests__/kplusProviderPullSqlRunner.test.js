'use strict';

// Exercise the runner's actual source with a real stdin-consuming child.
// Replace only the Docker executable: no Docker, database or payment access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const realExec = promisify(execFile);
const source = fs.readFileSync(path.join(__dirname, 'kplusProviderPullConcurrency.test.js'), 'utf8');
const file = ts.createSourceFile('fixture.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const sourceFunction = name => file.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === name).getText(file);

function actualRunner(db, executor) {
  return new Function('DB', 'execFileAsync', 'assert',
    `${sourceFunction('safeDb')}\n${sourceFunction('psql')}\nreturn psql;`)(db, executor, assert);
}

function nodeExecutor(childScript, calls) {
  return (command, args, options) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 4), ['exec', '-i', 'b35-disposable-local-test', 'psql']);
    assert.ok(args.includes('ON_ERROR_STOP=1'));
    assert.deepEqual(args.slice(-2), ['-f', '-']);
    calls.push({ command, args });
    return realExec(process.execPath, ['-e', childScript], {
      ...options, timeout: 8000, killSignal: 'SIGKILL',
    });
  };
}

test('K+ actual SQL runner sends multiline UTF8 SQL and EOF to its child', async () => {
  const calls = [];
  const executor = nodeExecutor(
    "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s));",
    calls,
  );
  const psql = actualRunner('b35-disposable-local-test', executor);
  const sql = "select '旅行🙂';\nselect 1;\n";
  assert.equal(await psql(sql), sql.trim());
  assert.equal(calls.length, 1);
});

test('K+ actual SQL runner propagates a nonzero process exit after input delivery', async () => {
  const calls = [];
  const executor = nodeExecutor(
    "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('synthetic SQL failure');process.exitCode=17;});",
    calls,
  );
  const psql = actualRunner('b35-disposable-local-test', executor);
  await assert.rejects(() => psql('select invalid;'), error => error.code === 17);
  assert.equal(calls.length, 1);
});

test('K+ actual SQL runner fails closed on stdin errors even if the process reports success', async () => {
  const executor = () => {
    const execution = Promise.resolve({ stdout: 'must not be returned' });
    const stdin = new EventEmitter();
    stdin.end = (_sql, callback) => queueMicrotask(() => {
      const error = Object.assign(new Error('synthetic input failure'), { code: 'EPIPE' });
      stdin.emit('error', error);
      callback(error);
    });
    execution.child = { stdin };
    return execution;
  };
  await assert.rejects(() => actualRunner('b35-disposable-local-test', executor)('select 1;'),
    error => error.code === 'EPIPE');
});

test('K+ actual SQL runner preserves disposable-only target refusals before child creation', async () => {
  for (const db of ['prod-test', 'staging-local', 'yzqjvd-test', 'wyyuqf-local', 'ordinary-db']) {
    let calls = 0;
    const psql = actualRunner(db, () => { calls++; throw new Error('must not dispatch'); });
    await assert.rejects(() => psql('select 1;'));
    assert.equal(calls, 0);
  }
});
