'use strict';

/**
 * HUMAN REVIEW RUBRIC — spec sections 15 (Class C) and 47.
 * Subjective dimensions, each 1-5 with explicit anchors. Never pre-scored by
 * the harness (spec section 47): the packet builder emits these anchors as
 * text for a human reviewer to fill in, and nothing here computes a score.
 */

const RUBRIC_VERSION = 'RUBRIC_V1';

const RUBRIC_DIMENSIONS = [
  {
    id: 'USEFULNESS',
    prompt: 'Would this response actually help the user get dressed / decide?',
    anchors: {
      1: 'Not useful -- vague, generic, or non-responsive to the request.',
      2: 'Marginally useful -- technically on-topic but not actionable.',
      3: 'Somewhat useful -- actionable but missing an obvious consideration.',
      4: 'Useful -- actionable and relevant, minor gaps.',
      5: 'Highly useful -- directly actionable and well-matched to the request.',
    },
  },
  {
    id: 'STYLE_COHERENCE',
    prompt: 'Does the recommended outfit/look actually work together?',
    anchors: {
      1: 'Incoherent -- pieces clash in formality, season, or occasion.',
      2: 'Weak coherence -- one clear mismatch.',
      3: 'Adequate -- coherent but unremarkable.',
      4: 'Coherent and considered.',
      5: 'Cohesive and stylistically compelling.',
    },
  },
  {
    id: 'PERSONALIZATION',
    prompt: 'Does the response reflect this specific user\'s Closet/Signature Style, not generic advice?',
    anchors: {
      1: 'Generic -- could apply to anyone.',
      2: 'Weak personalization -- one generic nod to their data.',
      3: 'Moderate -- uses Closet or Style, not both.',
      4: 'Good -- meaningfully grounded in both Closet and Style.',
      5: 'Strongly personalized -- clearly could only be written for this user.',
    },
  },
  {
    id: 'SPECIFICITY',
    prompt: 'Are the recommendations concrete (specific items/colors) or vague ("wear something nice")?',
    anchors: {
      1: 'Entirely vague.',
      2: 'Mostly vague, one concrete detail.',
      3: 'Mixed concrete and vague.',
      4: 'Mostly concrete.',
      5: 'Fully concrete and specific throughout.',
    },
  },
  {
    id: 'TRUST',
    prompt: 'Would a user reasonably trust this response as competent, honest styling advice?',
    anchors: {
      1: 'Untrustworthy -- confidently wrong or overreaching.',
      2: 'Low trust -- notable overreach or unsupported claim.',
      3: 'Neutral -- neither builds nor damages trust.',
      4: 'Trustworthy -- honest about limits, reasonable claims.',
      5: 'Highly trustworthy -- calibrated, transparent, and competent.',
    },
  },
];

module.exports = { RUBRIC_VERSION, RUBRIC_DIMENSIONS };
