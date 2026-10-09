'use strict';

/**
 * Hard spend guard for the live Scanner certification.
 *
 * `reserve()` runs BEFORE a request is handed to the network, so a refused
 * request never costs anything. Three independent ceilings apply, each checked
 * against what the campaign has ALREADY used (from the server's own quota ledger,
 * see campaignUsage.js) plus what this process has reserved:
 *
 *   - total image-mode requests (detection + selected-item; each is one Gemini call)
 *   - total commerce-only (MODE B) requests
 *   - image-mode requests per actor per UTC day
 *
 * Any refusal is recorded and thrown as BudgetExceededError. The runner treats the
 * first refusal as terminal: it stops, reports, and spends nothing further.
 */

class BudgetExceededError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BudgetExceededError';
    this.detail = detail;
  }
}

const IMAGE_MODE = 'image_mode';
const COMMERCE_ONLY = 'commerce_only';

/** MODE B is explicit and never inferred; everything else on this endpoint is an image-mode scan. */
function classifyRequest(body) {
  return body && typeof body === 'object' && body.requestMode === 'commerce_only'
    ? COMMERCE_ONLY
    : IMAGE_MODE;
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function createBudget({
  limits,
  prior = {},
  clock = () => new Date(),
} = {}) {
  if (!limits
    || !Number.isInteger(limits.imageModeTotal)
    || !Number.isInteger(limits.commerceOnlyTotal)
    || !Number.isInteger(limits.imageModePerActorPerUtcDay)) {
    throw new TypeError('budget limits must be explicit integers');
  }
  const priorImage = prior.imageMode ?? 0;
  const priorCommerce = prior.commerceOnly ?? 0;
  const priorActorDay = prior.imageModePerActorToday ?? {};

  const used = { imageMode: 0, commerceOnly: 0, byActorDay: {} };
  const refused = [];

  function remaining() {
    return {
      imageMode: limits.imageModeTotal - priorImage - used.imageMode,
      commerceOnly: limits.commerceOnlyTotal - priorCommerce - used.commerceOnly,
    };
  }

  function refuse(reason, detail) {
    refused.push({ reason, ...detail });
    throw new BudgetExceededError(`budget refused: ${reason}`, detail);
  }

  return {
    limits,
    prior: { imageMode: priorImage, commerceOnly: priorCommerce },

    /**
     * @param {{kind: string, actor: string}} request
     */
    reserve({ kind, actor }) {
      const left = remaining();
      if (kind === COMMERCE_ONLY) {
        if (left.commerceOnly <= 0) refuse('commerce_only_total', { kind, actor, left });
        used.commerceOnly += 1;
        return;
      }
      if (kind !== IMAGE_MODE) refuse('unknown_kind', { kind, actor });
      if (left.imageMode <= 0) refuse('image_mode_total', { kind, actor, left });
      const day = utcDay(clock());
      const key = `${actor}|${day}`;
      const actorToday = (priorActorDay[actor] ?? 0) + (used.byActorDay[key] ?? 0);
      if (actorToday >= limits.imageModePerActorPerUtcDay) {
        refuse('image_mode_per_actor_per_day', { kind, actor, day, actorToday });
      }
      used.imageMode += 1;
      used.byActorDay[key] = (used.byActorDay[key] ?? 0) + 1;
    },

    snapshot() {
      return {
        limits,
        prior: { imageMode: priorImage, commerceOnly: priorCommerce, imageModePerActorToday: { ...priorActorDay } },
        usedThisRun: { imageMode: used.imageMode, commerceOnly: used.commerceOnly, byActorDay: { ...used.byActorDay } },
        remaining: remaining(),
        refused: refused.slice(),
      };
    },
    get tripped() { return refused.length > 0; },
  };
}

module.exports = {
  BudgetExceededError,
  COMMERCE_ONLY,
  IMAGE_MODE,
  classifyRequest,
  createBudget,
};
