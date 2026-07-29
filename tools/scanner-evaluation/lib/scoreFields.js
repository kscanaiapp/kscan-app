'use strict';

const { isUncertainty } = require('./datasetValidate');

/**
 * Field-level scoring dispositions.
 * Wrong certainty is penalized more heavily than honest uncertainty.
 */
const DISPOSITIONS = Object.freeze({
  CORRECT: 'correct',
  ACCEPTABLY_BROAD: 'acceptably_broad',
  INCORRECT: 'incorrect',
  UNSUPPORTED_CERTAINTY: 'unsupported_certainty',
  UNKNOWN_WHEN_EVIDENCE_EXISTS: 'unknown_when_evidence_exists',
  CORRECT_ABSTENTION: 'correct_abstention',
  INCORRECT_ABSTENTION: 'incorrect_abstention',
  UNSCORABLE: 'unscorable',
});

const FIELD_WEIGHTS = Object.freeze({
  category: 3,
  clothingType: 2,
  subtype: 2,
  primaryColor: 1.5,
  secondaryColors: 1,
  material: 1.5,
  pattern: 1,
  brand: 3,
  exactProduct: 4,
  expectedResultType: 3,
  abstention: 3,
});

const PENALTY_MULTIPLIERS = Object.freeze({
  [DISPOSITIONS.CORRECT]: 0,
  [DISPOSITIONS.ACCEPTABLY_BROAD]: 0.25,
  [DISPOSITIONS.INCORRECT]: 1,
  [DISPOSITIONS.UNSUPPORTED_CERTAINTY]: 1.75,
  [DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS]: 0.75,
  [DISPOSITIONS.CORRECT_ABSTENTION]: 0,
  [DISPOSITIONS.INCORRECT_ABSTENTION]: 1.25,
  [DISPOSITIONS.UNSCORABLE]: 0,
});

/** Parent → child breadth map for acceptably-broad clothing/subtype checks. */
const BROAD_PARENTS = Object.freeze({
  jacket: ['chore jacket', 'bomber jacket', 'denim jacket', 'moto jacket', 'blazer'],
  coat: ['trench coat', 'overcoat', 'raincoat', 'wool coat', 'parka'],
  outerwear: ['jacket', 'coat', 'blazer', 'parka', 'trench'],
  bottoms: ['jeans', 'pants', 'trousers', 'skirt', 'shorts'],
  tops: ['t-shirt', 'shirt', 'blouse', 'sweater', 'hoodie', 'top'],
  footwear: ['sneakers', 'boots', 'loafers', 'sandals', 'heels', 'shoes'],
  dresses: ['dress', 'gown', 'jumpsuit'],
  accessories: ['bag', 'belt', 'hat', 'scarf', 'eyewear', 'jewelry', 'accessory'],
});

function normalizeToken(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokensEqual(a, b) {
  return normalizeToken(a) === normalizeToken(b);
}

function isConcrete(value) {
  return typeof value === 'string' && value.trim().length > 0 && !isUncertainty(value);
}

function isBroadMatch(prediction, groundTruth) {
  const pred = normalizeToken(prediction);
  const truth = normalizeToken(groundTruth);
  if (!pred || !truth || pred === truth) return false;
  if (truth.includes(pred) && pred.length >= 3) return true;
  const children = BROAD_PARENTS[pred];
  if (children && children.some((child) => truth === child || truth.includes(child))) {
    return true;
  }
  return false;
}

/**
 * Score a single taxonomy/attribute field.
 * @returns {{ field: string, disposition: string, penalty: number, notes: string }}
 */
function scoreField(field, groundTruth, prediction) {
  const weight = FIELD_WEIGHTS[field] || 1;

  if (isUncertainty(groundTruth) || groundTruth == null) {
    if (!isConcrete(prediction)) {
      return {
        field,
        disposition: DISPOSITIONS.UNSCORABLE,
        penalty: 0,
        notes: 'ground truth uncertain; prediction also non-concrete',
      };
    }
    // Predicting a concrete value when GT is unknown/not_visible is unsupported certainty
    // for brand/exactProduct; for other fields it is unsupported if GT is unknown/not_visible,
    // or incorrect if GT is not_applicable.
    if (groundTruth === 'not_applicable') {
      return {
        field,
        disposition: DISPOSITIONS.INCORRECT,
        penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.INCORRECT],
        notes: 'predicted concrete value where field is not applicable',
      };
    }
    return {
      field,
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.UNSUPPORTED_CERTAINTY],
      notes: 'concrete prediction against uncertain ground truth',
    };
  }

  if (!isConcrete(prediction)) {
    if (isUncertainty(prediction) || prediction == null || prediction === '') {
      return {
        field,
        disposition: DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS,
        penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS],
        notes: 'prediction uncertain while labeled evidence exists',
      };
    }
    return {
      field,
      disposition: DISPOSITIONS.UNSCORABLE,
      penalty: 0,
      notes: 'prediction missing or malformed',
    };
  }

  if (tokensEqual(prediction, groundTruth)) {
    return {
      field,
      disposition: DISPOSITIONS.CORRECT,
      penalty: 0,
      notes: 'exact field match',
    };
  }

  if (isBroadMatch(prediction, groundTruth)) {
    return {
      field,
      disposition: DISPOSITIONS.ACCEPTABLY_BROAD,
      penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.ACCEPTABLY_BROAD],
      notes: 'prediction is acceptably broader than ground truth',
    };
  }

  return {
    field,
    disposition: DISPOSITIONS.INCORRECT,
    penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.INCORRECT],
    notes: 'prediction does not match ground truth',
  };
}

function scoreSecondaryColors(groundTruth, prediction) {
  const field = 'secondaryColors';
  const weight = FIELD_WEIGHTS.secondaryColors;

  if (isUncertainty(groundTruth)) {
    if (Array.isArray(prediction) && prediction.length > 0) {
      return {
        field,
        disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
        penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.UNSUPPORTED_CERTAINTY],
        notes: 'concrete secondary colors against uncertain ground truth',
      };
    }
    return {
      field,
      disposition: DISPOSITIONS.UNSCORABLE,
      penalty: 0,
      notes: 'secondary colors unscorable',
    };
  }

  const truthSet = new Set(
    (Array.isArray(groundTruth) ? groundTruth : []).map(normalizeToken).filter(Boolean)
  );
  const predList = Array.isArray(prediction) ? prediction.map(normalizeToken).filter(Boolean) : [];

  if (truthSet.size === 0) {
    return { field, disposition: DISPOSITIONS.UNSCORABLE, penalty: 0, notes: 'empty GT' };
  }
  if (predList.length === 0) {
    return {
      field,
      disposition: DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS,
      penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS],
      notes: 'missing secondary colors',
    };
  }

  const hits = predList.filter((p) => truthSet.has(p)).length;
  if (hits === truthSet.size && predList.length === truthSet.size) {
    return { field, disposition: DISPOSITIONS.CORRECT, penalty: 0, notes: 'exact secondary set' };
  }
  if (hits > 0) {
    return {
      field,
      disposition: DISPOSITIONS.ACCEPTABLY_BROAD,
      penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.ACCEPTABLY_BROAD],
      notes: 'partial secondary color overlap',
    };
  }
  return {
    field,
    disposition: DISPOSITIONS.INCORRECT,
    penalty: weight * PENALTY_MULTIPLIERS[DISPOSITIONS.INCORRECT],
    notes: 'no secondary color overlap',
  };
}

function scoreBrand(groundTruth, prediction) {
  const base = scoreField('brand', groundTruth, prediction);
  if (
    (isUncertainty(groundTruth) || groundTruth === 'unknown') &&
    isConcrete(prediction)
  ) {
    return {
      ...base,
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      penalty: FIELD_WEIGHTS.brand * PENALTY_MULTIPLIERS[DISPOSITIONS.UNSUPPORTED_CERTAINTY],
      notes: 'brand false positive / unsupported certainty',
      brandFalsePositive: true,
    };
  }
  return { ...base, brandFalsePositive: false };
}

function scoreExactProduct(groundTruth, prediction, expectedResultType) {
  const base = scoreField('exactProduct', groundTruth, prediction);
  const claimedExact =
    isConcrete(prediction) || expectedResultType === 'likely_exact_match';

  if (
    (isUncertainty(groundTruth) ||
      groundTruth === 'unknown' ||
      expectedResultType === 'insufficient_evidence') &&
    claimedExact &&
    isConcrete(prediction)
  ) {
    return {
      ...base,
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      penalty:
        FIELD_WEIGHTS.exactProduct * PENALTY_MULTIPLIERS[DISPOSITIONS.UNSUPPORTED_CERTAINTY],
      notes: 'incorrect exact-match claim with unsupported certainty',
      incorrectExactMatch: true,
    };
  }

  if (
    expectedResultType === 'insufficient_evidence' &&
    expectedResultType &&
    isConcrete(prediction)
  ) {
    return {
      field: 'exactProduct',
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      penalty:
        FIELD_WEIGHTS.exactProduct * PENALTY_MULTIPLIERS[DISPOSITIONS.UNSUPPORTED_CERTAINTY],
      notes: 'exact product claimed under insufficient evidence',
      incorrectExactMatch: true,
    };
  }

  return { ...base, incorrectExactMatch: false };
}

function scoreAbstention(label, prediction) {
  const expected = Boolean(label.expectedAbstention);
  const predictedAbstain =
    prediction.abstained === true ||
    prediction.expectedResultType === 'insufficient_evidence' ||
    prediction.status === 'insufficient_visual_evidence' ||
    prediction.status === 'non_fashion';

  if (expected && predictedAbstain) {
    return {
      field: 'abstention',
      disposition: DISPOSITIONS.CORRECT_ABSTENTION,
      penalty: 0,
      notes: 'correct abstention',
    };
  }
  if (expected && !predictedAbstain) {
    return {
      field: 'abstention',
      disposition: DISPOSITIONS.INCORRECT_ABSTENTION,
      penalty: FIELD_WEIGHTS.abstention * PENALTY_MULTIPLIERS[DISPOSITIONS.INCORRECT_ABSTENTION],
      notes: 'failed to abstain when abstention expected',
    };
  }
  if (!expected && predictedAbstain) {
    return {
      field: 'abstention',
      disposition: DISPOSITIONS.INCORRECT_ABSTENTION,
      penalty: FIELD_WEIGHTS.abstention * PENALTY_MULTIPLIERS[DISPOSITIONS.INCORRECT_ABSTENTION],
      notes: 'abstained when identification was expected',
    };
  }
  return {
    field: 'abstention',
    disposition: DISPOSITIONS.CORRECT_ABSTENTION,
    penalty: 0,
    notes: 'no abstention expected or taken',
  };
}

function scoreResultType(label, prediction) {
  const expected = label.expectedResultType;
  const predicted = prediction.expectedResultType || prediction.resultType;
  if (!expected) {
    return {
      field: 'expectedResultType',
      disposition: DISPOSITIONS.UNSCORABLE,
      penalty: 0,
      notes: 'missing expected result type',
    };
  }
  if (!predicted) {
    return {
      field: 'expectedResultType',
      disposition: DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS,
      penalty:
        FIELD_WEIGHTS.expectedResultType *
        PENALTY_MULTIPLIERS[DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS],
      notes: 'missing predicted result type',
    };
  }
  if (predicted === expected) {
    return {
      field: 'expectedResultType',
      disposition: DISPOSITIONS.CORRECT,
      penalty: 0,
      notes: 'result type match',
    };
  }
  // Claiming likely_exact_match when expected is insufficient_evidence is severe.
  if (expected === 'insufficient_evidence' && predicted === 'likely_exact_match') {
    return {
      field: 'expectedResultType',
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      penalty:
        FIELD_WEIGHTS.expectedResultType *
        PENALTY_MULTIPLIERS[DISPOSITIONS.UNSUPPORTED_CERTAINTY],
      notes: 'exact-match claim under insufficient evidence',
    };
  }
  return {
    field: 'expectedResultType',
    disposition: DISPOSITIONS.INCORRECT,
    penalty: FIELD_WEIGHTS.expectedResultType * PENALTY_MULTIPLIERS[DISPOSITIONS.INCORRECT],
    notes: 'result type mismatch',
  };
}

/**
 * Score one case prediction against a governed label.
 * Deterministic: same inputs → same outputs.
 */
function scoreCase(label, prediction) {
  const pred = prediction || {};
  const fields = [
    scoreField('category', label.category, pred.category),
    scoreField('clothingType', label.clothingType, pred.clothingType),
    scoreField('subtype', label.subtype, pred.subtype),
    scoreField('primaryColor', label.primaryColor, pred.primaryColor),
    scoreSecondaryColors(label.secondaryColors, pred.secondaryColors),
    scoreField('material', label.material, pred.material),
    scoreField('pattern', label.pattern, pred.pattern),
    scoreBrand(label.brand, pred.brand),
    scoreExactProduct(label.exactProduct, pred.exactProduct, label.expectedResultType),
    scoreResultType(label, pred),
    scoreAbstention(label, pred),
  ];

  const totalPenalty = fields.reduce((sum, f) => sum + f.penalty, 0);
  const dispositionCounts = {};
  for (const f of fields) {
    dispositionCounts[f.disposition] = (dispositionCounts[f.disposition] || 0) + 1;
  }

  return {
    caseId: label.caseId,
    datasetVersion: label.datasetVersion,
    fields,
    totalPenalty,
    dispositionCounts,
    flags: {
      brandFalsePositive: fields.some((f) => f.brandFalsePositive),
      incorrectExactMatch: fields.some((f) => f.incorrectExactMatch),
      schemaParseFailure: Boolean(pred.schemaParseFailure),
    },
  };
}

/**
 * Aggregate case scores into dataset-level metrics.
 */
function aggregateScores(caseScores) {
  const metrics = {
    caseCount: caseScores.length,
    meanPenalty: 0,
    categoryCorrectRate: null,
    clothingTypeCorrectRate: null,
    subtypeCorrectRate: null,
    primaryColorCorrectRate: null,
    brandPrecisionSignals: {
      concretePredictions: 0,
      correct: 0,
      falsePositives: 0,
    },
    exactProductSignals: {
      concretePredictions: 0,
      incorrectExactMatchClaims: 0,
    },
    abstention: {
      correct: 0,
      incorrect: 0,
    },
    schemaParseFailureRate: 0,
    dispositionTotals: {},
  };

  if (caseScores.length === 0) return metrics;

  let penaltySum = 0;
  let schemaFailures = 0;

  const fieldCorrect = {
    category: { hit: 0, n: 0 },
    clothingType: { hit: 0, n: 0 },
    subtype: { hit: 0, n: 0 },
    primaryColor: { hit: 0, n: 0 },
  };

  for (const score of caseScores) {
    penaltySum += score.totalPenalty;
    if (score.flags.schemaParseFailure) schemaFailures += 1;
    if (score.flags.brandFalsePositive) {
      metrics.brandPrecisionSignals.falsePositives += 1;
      metrics.brandPrecisionSignals.concretePredictions += 1;
    }
    if (score.flags.incorrectExactMatch) {
      metrics.exactProductSignals.incorrectExactMatchClaims += 1;
      metrics.exactProductSignals.concretePredictions += 1;
    }

    for (const field of score.fields) {
      metrics.dispositionTotals[field.disposition] =
        (metrics.dispositionTotals[field.disposition] || 0) + 1;

      if (field.field === 'brand' && field.disposition === DISPOSITIONS.CORRECT) {
        metrics.brandPrecisionSignals.correct += 1;
        metrics.brandPrecisionSignals.concretePredictions += 1;
      }
      if (field.field === 'exactProduct' && isConcretePredictionDisposition(field)) {
        metrics.exactProductSignals.concretePredictions += 1;
      }
      if (field.field === 'abstention') {
        if (field.disposition === DISPOSITIONS.CORRECT_ABSTENTION) metrics.abstention.correct += 1;
        if (field.disposition === DISPOSITIONS.INCORRECT_ABSTENTION) {
          metrics.abstention.incorrect += 1;
        }
      }
      if (fieldCorrect[field.field]) {
        if (field.disposition !== DISPOSITIONS.UNSCORABLE) {
          fieldCorrect[field.field].n += 1;
          if (
            field.disposition === DISPOSITIONS.CORRECT ||
            field.disposition === DISPOSITIONS.ACCEPTABLY_BROAD
          ) {
            fieldCorrect[field.field].hit += 1;
          }
        }
      }
    }
  }

  metrics.meanPenalty = penaltySum / caseScores.length;
  metrics.schemaParseFailureRate = schemaFailures / caseScores.length;
  metrics.categoryCorrectRate = rate(fieldCorrect.category);
  metrics.clothingTypeCorrectRate = rate(fieldCorrect.clothingType);
  metrics.subtypeCorrectRate = rate(fieldCorrect.subtype);
  metrics.primaryColorCorrectRate = rate(fieldCorrect.primaryColor);
  return metrics;
}

function isConcretePredictionDisposition(field) {
  return (
    field.disposition === DISPOSITIONS.CORRECT ||
    field.disposition === DISPOSITIONS.INCORRECT ||
    field.disposition === DISPOSITIONS.UNSUPPORTED_CERTAINTY
  );
}

function rate(counter) {
  if (!counter.n) return null;
  return counter.hit / counter.n;
}

module.exports = {
  DISPOSITIONS,
  FIELD_WEIGHTS,
  PENALTY_MULTIPLIERS,
  scoreField,
  scoreBrand,
  scoreExactProduct,
  scoreAbstention,
  scoreCase,
  aggregateScores,
  isBroadMatch,
  normalizeToken,
};
