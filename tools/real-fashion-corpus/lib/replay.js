'use strict';

/**
 * Replay seam (mission section 31).
 *
 *   "The corpus must support scoring pre-recorded Scanner responses against
 *    real ground truth. If existing safe replay data exists, use it (check
 *    tools/fashion-match-quality/replay/). If not, make the ingestion/
 *    evaluation seam ready for future replay artifacts."
 *
 * Checked: `tools/fashion-match-quality/replay/` contains `replayRunner.js`
 * and `replaySchema.js` only. The `replay/corpus/` directory does not exist,
 * and FMQL's own `runReplay()` reports `READY_NO_CORPUS`. There is therefore
 * no existing safe replay data to use, so this module builds the seam.
 *
 * A replay record lets a paid/live Scanner run be captured ONCE and then
 * scored offline against real ground truth repeatedly, which is what makes a
 * zero-spend evaluation lane useful later. Records reuse FMQL's inherited
 * `validateReplayRecord` rather than defining a competing shape.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PATHS } = require('./paths');
const { validateReplayRecord } = require('../../fashion-match-quality/replay/replaySchema');
const { scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');

const REPLAY_DIR = path.join(PATHS.corpus, 'replay');

/**
 * Load replay records keyed by the case they replay.
 *
 * Returns { status, records, byCaseId, errors }.
 * `status` is READY_NO_REPLAY when none exist - the expected state today, and
 * a reportable one rather than an error.
 */
function loadReplayRecords({ dir = REPLAY_DIR } = {}) {
  const records = [];
  const errors = [];

  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        errors.push({ file, message: `unreadable JSON: ${err.message}` });
        continue;
      }

      const schema = validateReplayRecord(record);
      if (!schema.valid) {
        for (const message of schema.errors) errors.push({ file, replayId: record.replayId, message });
        continue;
      }

      // A replay record carries a captured Scanner RESPONSE. That response is
      // model output, and model output may never be ground truth (mission
      // section 5) - it is the thing being SCORED. A record that also tried to
      // supply ground truth would invert the whole evaluation, so it is refused.
      if (record.groundTruth !== undefined) {
        errors.push({
          file,
          replayId: record.replayId,
          message:
            'a replay record must not carry groundTruth. A replay is captured MODEL OUTPUT, which is what gets ' +
            'scored; ground truth comes from the corpus garment record and nowhere else (mission section 5).',
        });
        continue;
      }

      if (typeof record.caseId !== 'string' || record.caseId === '') {
        errors.push({
          file,
          replayId: record.replayId,
          message: 'a real-corpus replay record must name the caseId it replays',
        });
        continue;
      }

      const privacy = scanForPrivacyViolations(record);
      if (!privacy.safe) {
        for (const violation of privacy.violations) {
          errors.push({ file, replayId: record.replayId, message: `privacy_violation at ${violation.path}: ${violation.reason}` });
        }
        continue;
      }

      records.push(record);
    }
  }

  return {
    status: records.length === 0 ? 'READY_NO_REPLAY' : 'REPLAY_AVAILABLE',
    records,
    byCaseId: new Map(records.map((record) => [record.caseId, record])),
    errors,
    dir,
  };
}

module.exports = { REPLAY_DIR, loadReplayRecords };
