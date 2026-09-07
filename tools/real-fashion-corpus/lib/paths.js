'use strict';

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..', '..');

const PATHS = {
  root: ROOT,
  repoRoot: REPO_ROOT,
  corpus: path.join(ROOT, 'corpus'),
  corpusConfig: path.join(ROOT, 'corpus', 'corpus.json'),
  garments: path.join(ROOT, 'corpus', 'garments'),
  cases: path.join(ROOT, 'corpus', 'cases'),
  holdout: path.join(ROOT, 'corpus', 'holdout'),
  compiledDevelopment: path.join(ROOT, 'corpus', 'compiled', 'development'),
  compiledHoldout: path.join(ROOT, 'corpus', 'compiled', 'holdout'),
  holdoutInvocationLog: path.join(ROOT, 'corpus', 'HOLDOUT_INVOCATION_LOG.jsonl'),
  defaultAssetMount: path.join(ROOT, 'corpus', 'assets-mount'),
  intake: path.join(ROOT, 'intake'),
  intakeInbox: path.join(ROOT, 'intake', 'inbox'),
  reports: path.join(ROOT, 'reports'),
  // The inherited Fashion Match Quality authority. This lane reads from it and
  // never writes into it (design DM-02).
  fmql: path.join(REPO_ROOT, 'tools', 'fashion-match-quality'),
  fmqlRealCorpusDir: path.join(REPO_ROOT, 'tools', 'fashion-match-quality', 'corpus', 'real'),
};

module.exports = { PATHS };
