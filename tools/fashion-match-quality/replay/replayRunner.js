'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateReplayRecord } = require('./replaySchema');

const REPLAY_DIR = path.join(__dirname, 'corpus'); // empty until an owner supplies sanitized records

/**
 * Load any committed replay records. Returns [] (not an error) when the
 * directory is absent/empty - this is the expected state for this
 * autonomous build (spec section 22: "REPLAY CORPUS: NONE").
 */
function loadReplayCorpus() {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  return fs
    .readdirSync(REPLAY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, f), 'utf8')));
}

/**
 * Validate and "run" (offline, zero network) a replay corpus: for each
 * valid record, compare observedResponse against what L1 would produce
 * today for the same request, surfacing drift. Returns a status summary
 * rather than throwing, so an empty corpus is a normal, reportable state.
 */
function runReplay() {
  const records = loadReplayCorpus();
  if (records.length === 0) {
    return { status: 'READY_NO_CORPUS', recordCount: 0, results: [] };
  }

  const { runL1ForFixture } = require('../l1/runL1');
  const results = records.map((record) => {
    const { valid, errors } = validateReplayRecord(record);
    if (!valid) {
      return { replayId: record.replayId, status: 'INVALID', errors };
    }
    const l1 = runL1ForFixture({
      fixtureId: record.replayId,
      garmentIdentification: record.request.garmentIdentification,
      candidateProducts: record.request.candidateProducts,
    });
    return { replayId: record.replayId, status: l1.ok ? 'REPLAYED' : 'L1_BLOCKED', l1 };
  });

  return { status: 'PASS', recordCount: records.length, results };
}

module.exports = { REPLAY_DIR, loadReplayCorpus, runReplay };
