#!/usr/bin/env node

const { spawn } = require('node:child_process');

const STEPS = [
  ['npm', ['run', 'test:privacy']],
  ['npm', ['run', 'test:auth-privacy']],
  ['npm', ['run', 'test:verify-supabase']],
  ['npm', ['run', 'test:analyze-contract']],
  [
    'node',
    [
      '--test',
      '__tests__/routingGuard.test.js',
      '__tests__/processDeletionRequest.test.js',
      '__tests__/verifyAppleReadiness.test.js',
      '__tests__/manualDeletionAppleRevocation.test.js',
    ],
  ],
  ['npm', ['run', 'verify:apple-readiness']],
  ['npx', ['--yes', 'eas-cli@latest', 'metadata:lint']],
];

function runStep(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${[command, ...args].join(' ')}\n`);
    const commandConfig = getCommandConfig(command, args);
    const executable = commandConfig.command;
    const executableArgs = commandConfig.args;
    const child = spawn(executable, executableArgs, {
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
      }
    });
  });
}

function quoteWindowsArg(arg) {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function getCommandConfig(command, args) {
  if (process.platform !== 'win32') {
    return { command, args };
  }

  const shellLine = [command, ...args].map(quoteWindowsArg).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', shellLine],
  };
}

async function main() {
  for (const [command, args] of STEPS) {
    await runStep(command, args);
  }

  console.log('\nApple submission local verification passed.');
  console.log('External gates remain: EAS iOS credentials, App Store Connect app ID, TestFlight/device QA, and manual App Store submission.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  STEPS,
  getCommandConfig,
  runStep,
};
