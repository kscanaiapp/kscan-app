/**
 * Argument-boundary-preserving process invocation for the governed staging
 * tooling (RP-114).
 *
 * The staging helpers used to pass `shell: process.platform === 'win32'` to
 * execFileSync. On Windows that hands the whole invocation to cmd.exe, and Node
 * builds the command line for it by joining the file and its arguments with a
 * single space -- no quoting, no escaping at all. Two consequences follow, and
 * both are silent:
 *
 *   1. ARGV BOUNDARIES ARE LOST. Any argument containing a space becomes
 *      several arguments. A checkout under "C:\Users\Ada Lovelace\kscan-app"
 *      turns
 *          supabase db query --linked -f C:\Users\Ada Lovelace\...\x.sql
 *      into a `-f` of "C:\Users\Ada" plus a stray trailing argument, and
 *      readRemoteMigrationVersions' own
 *          supabase db query "select version from ... order by version" --linked
 *      is destroyed outright, because SQL is mostly spaces.
 *
 *   2. CMD METACHARACTERS ARE INTERPRETED. `&`, `|`, `<`, `>` are read by
 *      cmd.exe as command syntax rather than as argument text. `a & b` runs two
 *      commands, and cmd returns the LAST one's exit status -- so a supabase
 *      invocation that failed can still exit 0. That is the worst shape this
 *      defect takes: a command that ran with the wrong arguments and reported
 *      success.
 *
 * The repair is to stop using a shell. `runWinSafe` spawns the executable
 * directly, so the operating system carries argv across the process boundary
 * and nothing re-parses it. The one case that genuinely needs a shell is a
 * Windows `.cmd`/`.bat` shim -- Node refuses to spawn those without one and
 * raises EINVAL -- so that single error is caught and retried through cmd.exe
 * with a command line this module escapes itself. Escaping we perform is
 * reviewable; escaping we delegate to a shell is not.
 *
 * ENOENT is deliberately NOT part of the fallback: it means the executable is
 * not installed, and callers (notably runDenoCheck) distinguish that from a
 * failed run. Routing it through cmd.exe would turn "deno is absent" into an
 * ordinary non-zero exit and lose that distinction.
 */

import { execFileSync, spawnSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/** Node's error code when asked to spawn a .cmd/.bat without a shell. */
const SHIM_REQUIRES_SHELL = 'EINVAL';

export class ArgumentBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgumentBoundaryError';
  }
}

/**
 * Rejects arguments that cannot survive transport as a single argv entry on
 * any platform. A NUL terminates the string in the OS call, and a newline is
 * indistinguishable from a command separator once a shell is involved -- both
 * would silently deliver something other than what the caller wrote.
 */
export function assertTransportableArgs(args) {
  if (!Array.isArray(args)) {
    throw new ArgumentBoundaryError('Arguments must be passed as an array, never as one string.');
  }
  args.forEach((arg, index) => {
    if (typeof arg !== 'string') {
      throw new ArgumentBoundaryError(
        `Argument ${index} is ${typeof arg}, not a string; argv entries must be explicit strings.`,
      );
    }
    if (arg.includes('\0')) {
      throw new ArgumentBoundaryError(`Argument ${index} contains a NUL byte and cannot be passed as argv.`);
    }
    if (/[\r\n]/.test(arg)) {
      throw new ArgumentBoundaryError(`Argument ${index} contains a newline and cannot be passed as argv.`);
    }
  });
}

/**
 * Quotes one argument so cmd.exe hands it to the child unchanged.
 *
 * Two parsers sit between this string and the child's argv, and both have to be
 * satisfied:
 *
 *   1. cmd.exe reads the command line first and acts on its own metacharacters
 *      wherever they are neither quoted nor caret-escaped.
 *   2. The child's C runtime then splits what survives into argv using the
 *      Windows rules, where a run of backslashes is only special immediately
 *      before a quote.
 *
 * So the value is quoted for the CRT first, then every cmd metacharacter in the
 * result -- including the quotes just added -- is caret-escaped. cmd strips the
 * carets, the CRT sees exactly the quoted form, and the child receives the
 * original string as one argv entry.
 *
 * `%` is refused rather than escaped. cmd expands `%NAME%` while parsing the
 * command line, before caret handling can protect it, so there is no escape
 * that makes a literal `%` survive this path. Failing closed reports the
 * problem; escaping it anyway would hand the child a different argument than
 * the caller wrote, which is the very defect this module exists to remove.
 */
export function quoteForCmd(arg) {
  const value = String(arg);
  if (value.includes('%')) {
    throw new ArgumentBoundaryError(
      'Refusing to pass an argument containing "%" through the Windows cmd.exe shim: ' +
        'cmd expands %NAME% during command-line parsing, so no escaping can deliver a ' +
        'literal "%" to the child. Invoke a real executable (supabase.exe / deno.exe) ' +
        'rather than a .cmd shim if this argument is required.',
    );
  }

  // Layer 1 -- Windows CRT quoting, so the child's argv reconstructs `value`.
  let quoted = value.replace(/(\\*)"/g, '$1$1\\"');
  if (value === '' || /[\s"&|<>^()!,;=]/.test(value)) {
    quoted = `"${quoted.replace(/(\\*)$/, '$1$1')}"`;
  }

  // Layer 2 -- cmd.exe metacharacters, the layer-1 quotes included.
  return quoted.replace(/[()<>&|^"!]/g, '^$&');
}

/**
 * Runs `file` with `args` as a real argv, never through a shell.
 *
 * Returns and throws exactly as execFileSync does: stdout on success, and on
 * failure the same error object carrying `status`, `stdout`, `stderr` and
 * `code`, so existing callers' exit-code and stream handling is unchanged.
 */
export function runWinSafe(file, args, options = {}) {
  assertTransportableArgs(args);
  const execOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    shell: false,
  };

  try {
    return execFileSync(file, args, execOptions);
  } catch (error) {
    if (!IS_WINDOWS || error?.code !== SHIM_REQUIRES_SHELL) throw error;
    // A .cmd/.bat shim. Build the command line ourselves so the escaping is
    // this module's decision rather than an unquoted join's.
    const commandLine = [file, ...args].map(quoteForCmd).join(' ');
    return execFileSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `"${commandLine}"`],
      { ...execOptions, windowsVerbatimArguments: true },
    );
  }
}

/**
 * spawnSync equivalent of runWinSafe, for callers that need the full result
 * object (status, stdout, stderr) or a non-piped stdio mode rather than a
 * throw-on-failure return value. Same no-shell rule and same single EINVAL
 * fallback for a Windows .cmd/.bat shim.
 */
export function spawnWinSafe(file, args, options = {}) {
  assertTransportableArgs(args);
  const spawnOptions = { encoding: 'utf8', ...options, shell: false };

  const direct = spawnSync(file, args, spawnOptions);
  if (!IS_WINDOWS || direct.error?.code !== SHIM_REQUIRES_SHELL) return direct;

  const commandLine = [file, ...args].map(quoteForCmd).join(' ');
  return spawnSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', `"${commandLine}"`],
    { ...spawnOptions, windowsVerbatimArguments: true },
  );
}
