'use strict';

/**
 * Materialize the certified v140 source closure into a private, immutable run
 * snapshot.
 *
 * WHY THIS EXISTS
 * The Deno harness previously reached the certified source through `--cert-root`,
 * a path to an external worktree. A worktree is mutable: it can be checked out to
 * another commit, edited, or deleted between runs, and nothing in the run record
 * would show it. A baseline that cannot prove which bytes it executed is not a
 * baseline.
 *
 * The snapshot is built from the GIT OBJECT STORE at the certified commit, not
 * from any working copy, so it does not depend on that worktree existing at all.
 * Every file is verified against the pinned hashes in adapter/certified-v140.json
 * before it is written, and the closure is re-verified after writing.
 *
 * WHAT IT REFUSES
 *   - a destination inside any Git worktree (private artifacts never enter Git);
 *   - a certified commit whose closure does not match the pinned record;
 *   - a file outside the pinned closure (no unapproved module can appear);
 *   - overwriting an existing snapshot (snapshots are immutable once written).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const certifiedSource = require('./certifiedSource');
const { assertOutsideGit } = require('./imagePreparation');

const SNAPSHOT_RECORD = 'certified-snapshot.json';

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * The identity a run must quote. Any change here changes the executed bytes and
 * must invalidate a resume.
 */
function snapshotIdentity(record, ref) {
  return {
    certifiedCommit: ref,
    scanIdentifyTreeHash: record.scanIdentifyTreeHash,
    bundleHash: record.bundleHash,
    treeHash: record.treeHash,
    entry: record.entry,
    bundleFileCount: record.bundleFileCount,
    treeFileCount: record.treeFileCount,
    remoteSpecifiers: record.remoteSpecifiers.slice(),
  };
}

/**
 * Build the snapshot.
 *
 * @param {{ ref?: string, destination: string, force?: boolean }} options
 */
function materialize({ ref = null, destination, force = false } = {}) {
  if (!destination) throw new Error('a snapshot destination is required');
  const target = path.resolve(destination);

  // Private artifacts must never land inside a Git worktree.
  assertOutsideGit(target);

  const record = certifiedSource.loadRecord();
  const commit = ref || record.certifiedBranches.ios.sha;

  if (!certifiedSource.refExists(commit)) {
    throw new Error(`certified commit is not reachable in this object store: ${commit}`);
  }

  // Verify BEFORE writing anything. A mismatch must not leave a partial tree.
  const closure = certifiedSource.verifyClosure(commit);
  if (!closure.ok) {
    const detail = [
      closure.error,
      closure.mismatches.length ? `${closure.mismatches.length} hash mismatch(es)` : null,
      closure.missing.length ? `${closure.missing.length} missing file(s)` : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`certified closure verification failed at ${commit}: ${detail}`);
  }

  if (fs.existsSync(target)) {
    if (!force) throw new Error(`snapshot already exists and snapshots are immutable: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(target, { recursive: true });

  const written = [];
  for (const file of record.files) {
    const bytes = certifiedSource.readBlob(commit, file.path);
    const actual = sha256Hex(bytes);
    if (actual !== file.sha256) {
      // Defensive: verifyClosure already checked this. If it trips here the
      // object store changed underneath us mid-write.
      fs.rmSync(target, { recursive: true, force: true });
      throw new Error(`hash drift while writing ${file.path}`);
    }
    const destinationFile = path.join(target, file.path);
    const resolved = path.resolve(destinationFile);
    if (!resolved.startsWith(target + path.sep)) {
      fs.rmSync(target, { recursive: true, force: true });
      throw new Error(`closure path escapes the snapshot root: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, bytes);
    written.push({ path: file.path, sha256: actual, bundle: file.bundle === true });
  }

  const identity = snapshotIdentity(record, commit);
  const closureAggregate = sha256Hex(
    Buffer.from(
      written
        .map((f) => `${f.path}:${f.sha256}\n`)
        .sort()
        .join(''),
      'utf8'
    )
  );

  const snapshot = {
    snapshotVersion: '1.0.0',
    ...identity,
    fileCount: written.length,
    closureAggregateSha256: closureAggregate,
    entryPath: path.join(target, record.entry),
    materializedFrom: 'git object store',
    immutable: true,
    note:
      'Built from the certified commit in the git object store, not from a working copy. The adapter must execute THIS tree and quote closureAggregateSha256 in every run.',
  };
  fs.writeFileSync(
    path.join(target, SNAPSHOT_RECORD),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { flag: 'wx' }
  );

  return { ...snapshot, root: target };
}

/**
 * Re-verify an existing snapshot on disk against the pinned record.
 *
 * Called before every live run: a snapshot that drifted must stop execution
 * rather than silently produce results attributed to the certified bundle.
 */
function verifySnapshot(root) {
  const target = path.resolve(root);
  const recordPath = path.join(target, SNAPSHOT_RECORD);
  const errors = [];

  if (!fs.existsSync(recordPath)) {
    return { ok: false, root: target, errors: [{ check: 'snapshot_record', message: 'no certified-snapshot.json' }] };
  }
  const snapshot = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const record = certifiedSource.loadRecord();

  if (snapshot.bundleHash !== record.bundleHash) {
    errors.push({ check: 'bundle_hash', message: `snapshot ${snapshot.bundleHash} != pinned ${record.bundleHash}` });
  }
  if (snapshot.scanIdentifyTreeHash !== record.scanIdentifyTreeHash) {
    errors.push({ check: 'tree_hash', message: 'scan-identify tree hash differs from the pinned record' });
  }

  const observed = [];
  const pinned = new Map(record.files.map((f) => [f.path, f.sha256]));
  for (const [relative, expected] of pinned) {
    const absolute = path.join(target, relative);
    if (!fs.existsSync(absolute)) {
      errors.push({ check: 'file_present', file: relative, message: 'missing from snapshot' });
      continue;
    }
    const actual = sha256Hex(fs.readFileSync(absolute));
    observed.push({ path: relative, sha256: actual });
    if (actual !== expected) {
      errors.push({ check: 'file_hash', file: relative, message: 'snapshot file does not match the certified hash' });
    }
  }

  // No unapproved module may exist inside the snapshot.
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else acc.push(path.relative(target, full).replace(/\\/g, '/'));
    }
    return acc;
  };
  const onDisk = walk(target).filter((p) => p !== SNAPSHOT_RECORD);
  for (const file of onDisk) {
    if (!pinned.has(file)) {
      errors.push({ check: 'unapproved_module', file, message: 'file is not part of the certified closure' });
    }
  }

  const closureAggregate = sha256Hex(
    Buffer.from(
      observed
        .map((f) => `${f.path}:${f.sha256}\n`)
        .sort()
        .join(''),
      'utf8'
    )
  );
  if (snapshot.closureAggregateSha256 && closureAggregate !== snapshot.closureAggregateSha256) {
    errors.push({ check: 'closure_aggregate', message: 'closure aggregate does not match the snapshot record' });
  }

  return {
    ok: errors.length === 0,
    root: target,
    certifiedCommit: snapshot.certifiedCommit,
    bundleHash: snapshot.bundleHash,
    closureAggregateSha256: closureAggregate,
    fileCount: observed.length,
    errors,
  };
}

module.exports = { SNAPSHOT_RECORD, materialize, verifySnapshot, snapshotIdentity, sha256Hex };
