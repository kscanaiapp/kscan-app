'use strict';

/**
 * CONVERSATION SEQUENCES — Build 35 Elise Conversation Quality V2.
 *
 * Extends this harness (it does not start a second one) with multi-turn
 * SEQUENCES evaluated against the real, unmodified client task frame
 * `services/style-chat/eliseConversationFrame.ts`, loaded the same way L1.5
 * loads production code: Node's native TypeScript type-stripping, no network,
 * no model.
 *
 * Two kinds of result, never mixed:
 *
 *   DETERMINISTIC — contract pass/fail per dimension: context retention,
 *   constraint retention, ownership grounding, reference resolution, task
 *   reset, rejection/correction, contradiction, action selection.
 *
 *   SUBJECTIVE — response relevance, fashion specificity, verbosity. Reported
 *   as HUMAN_REVIEW with at most an advisory measurement (reply word count).
 *   A word count is not a quality verdict and is never folded into pass/fail.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FRAME_REL = 'services/style-chat/eliseConversationFrame.ts';
const SEQUENCES_PATH = path.join(__dirname, 'conversationSequences.json');

const DIMENSION_OF = {
  taskReset: 'taskReset',
  relation: 'contextRetention',
  taskKind: 'contextRetention',
  garmentFocus: 'contextRetention',
  occasion: 'contextRetention',
  memoryOp: 'contextRetention',
  budget: 'constraintRetention',
  colors: 'constraintRetention',
  negations: 'constraintRetention',
  formality: 'constraintRetention',
  warmth: 'constraintRetention',
  ownedOnly: 'ownershipGrounding',
  reference: 'referenceResolution',
  referenceOrdinal: 'referenceResolution',
  localClarification: 'referenceResolution',
  rejections: 'rejectionCorrection',
  corrections: 'rejectionCorrection',
  violations: 'contradiction',
  commerce: 'actionSelection',
};

const SUBJECTIVE_DIMENSIONS = ['responseRelevance', 'fashionSpecificity', 'verbosity'];

async function loadFrame() {
  const url = `file://${path.resolve(REPO_ROOT, FRAME_REL).replace(/\\/g, '/')}`;
  return import(url);
}

function loadSequences() {
  return JSON.parse(fs.readFileSync(SEQUENCES_PATH, 'utf8'));
}

function toMessages(turns) {
  return (turns ?? []).map((t) => {
    const uiBlocks = [];
    for (const spec of t.blocks ?? []) {
      if (spec === 'intent') uiBlocks.push({ type: 'commerce_shopping_intent', state: { stateVersion: 1 } });
      else if (spec.startsWith('notice:')) uiBlocks.push({ type: 'elise_conversation_notice', code: spec.slice(7) });
      else if (spec.startsWith('shelf:')) {
        uiBlocks.push({ type: 'commerce_shopping_intent', state: { stateVersion: 1 } });
        uiBlocks.push({
          type: 'commerce_products',
          status: 'results',
          products: spec.slice(6).split('|').map((title) => ({ title })),
        });
      }
    }
    return { sender: t.role, content: t.content, uiBlocks };
  });
}

function commerceCode(decision) {
  if (decision.action === 'allow') return 'allow';
  return decision.code === 'shopping_held_owned_only' ? 'hold_owned_only' : 'hold_not_requested';
}

/** Project the analysis onto the fixture vocabulary. */
function observe(frame, analysis, candidateReply) {
  const f = analysis.frame;
  return {
    taskReset: analysis.taskReset,
    relation: analysis.relation,
    taskKind: f.taskKind,
    garmentFocus: f.garmentFocus,
    occasion: f.occasion,
    memoryOp: analysis.memoryOp,
    budget: f.budget ? `${f.budget.amount} ${f.budget.currency}` : null,
    colors: [...f.colors],
    negations: f.negations.map((n) => `${n.axis}:${n.token}`),
    formality: f.formality,
    warmth: f.warmth,
    ownedOnly: f.ownedOnly,
    reference: analysis.reference.status,
    referenceOrdinal: analysis.reference.ordinal ?? null,
    localClarification: analysis.localClarification,
    rejections: f.rejections.map((r) => `${r.garmentClass}:${[...r.modifiers, r.noun].join(' ')}`),
    corrections: f.corrections.map((c) => `${c.from}>${c.to}`),
    violations: typeof candidateReply === 'string'
      ? frame.validateEliseReply(f, candidateReply).map((v) => `${v.kind}:${v.token}`)
      : [],
    commerce: commerceCode(frame.decideEliseCommerceActivation(analysis)),
  };
}

function wordCount(text) {
  return typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : null;
}

async function evaluateConversationSequences() {
  const frame = await loadFrame();
  const fixtures = loadSequences();
  const results = [];
  const byDimension = {};

  for (const sequence of fixtures.sequences) {
    const started = process.hrtime.bigint();
    const analysis = frame.analyzeEliseTurn({ messages: toMessages(sequence.turns), message: sequence.message });
    const frameMs = Number(process.hrtime.bigint() - started) / 1e6;
    const observed = observe(frame, analysis, sequence.candidateReply);

    const checks = [];
    for (const [key, expected] of Object.entries(sequence.expect)) {
      const actual = observed[key];
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      const dimension = DIMENSION_OF[key] ?? 'contextRetention';
      checks.push({ key, dimension, expected, actual, pass });
      byDimension[dimension] = byDimension[dimension] ?? { pass: 0, fail: 0 };
      byDimension[dimension][pass ? 'pass' : 'fail'] += 1;
    }

    const words = wordCount(sequence.candidateReply);
    results.push({
      id: sequence.id,
      journey: sequence.journey,
      deterministic: { pass: checks.every((c) => c.pass), checks },
      subjective: Object.fromEntries(SUBJECTIVE_DIMENSIONS.map((d) => [d, 'HUMAN_REVIEW'])),
      advisory: {
        candidateReplyWords: words,
        ...(sequence.verbosityBudgetWords
          ? { verbosityBudgetWords: sequence.verbosityBudgetWords, withinBudget: words !== null && words <= sequence.verbosityBudgetWords }
          : {}),
        frameMs: Number(frameMs.toFixed(3)),
      },
    });
  }

  const deterministicPass = results.filter((r) => r.deterministic.pass).length;
  return {
    fixtureSetVersion: fixtures.fixtureSetVersion,
    evidenceFraming:
      'DETERMINISTIC CONTRACT results only. Synthetic candidate replies exercise the contradiction check; ' +
      'they are not production output. Subjective quality is HUMAN_REVIEW and is not scored here.',
    sequenceCount: results.length,
    deterministicPass,
    deterministicFail: results.length - deterministicPass,
    byDimension,
    liveModelCalls: 0,
    networkCalls: 0,
    results,
  };
}

module.exports = { evaluateConversationSequences, loadSequences, DIMENSION_OF, SUBJECTIVE_DIMENSIONS };
