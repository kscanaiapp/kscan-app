/**
 * Build 34 / K+ Wardrobe Concierge -- staged progress for a wardrobe turn.
 *
 * WHY A STAGED INDICATOR AT ALL
 * -----------------------------
 * A Concierge turn does real work before the model is even called: an
 * entitlement RPC, a Closet census page, a candidate retrieval across several
 * stores, deterministic scoring, then generation. That is seconds, not
 * milliseconds. A single spinner over that window does not read as "thinking",
 * it reads as "stuck", and the customer's next move is to leave.
 *
 * THE ONE RULE THIS FILE ENFORCES
 * ------------------------------
 * A progress stage describes WORK REQUESTED, never a RESULT OBTAINED.
 *
 * The client cannot see the census, the shortlist or the entitlement decision
 * the server actually made, so it must not narrate them. Every line below is
 * true from the moment the request leaves the device, and none of them says
 * anything about what was found. There is deliberately no terminal "Done",
 * no count, and no "Found N pieces": the answer itself is the only thing
 * allowed to report an outcome, and it arrives from the server validated.
 *
 * WHY THE STAGES ARE GATED
 * ------------------------
 * "Pulling your Closet together" on a turn that never touches the Closet is a
 * small lie that costs exactly the trust this feature is trying to build. So
 * the staged copy appears only when the client has positive grounds to expect
 * a wardrobe turn: the Concierge capability is on, the entitlement store says
 * the actor is active, and the message itself reads as a wardrobe question.
 * Anything short of that keeps the ordinary Elise indicator.
 *
 * The gate is a NECESSARY condition, never a sufficient one -- the server can
 * still decline the wardrobe path (its own flags, a lapsed entitlement, an
 * unreadable Closet), and when it does, the answer simply arrives with no
 * Closet evidence and no claim was made either way.
 */

/** One stage of the indicator. `atMs` is elapsed time since the send started. */
export interface ConciergeProgressStage {
  readonly id: string;
  readonly atMs: number;
  readonly title: string;
  readonly subtitle: string;
}

/**
 * The stages, in order.
 *
 * Timings are deliberately generous rather than optimistic: a stage that
 * advances faster than the work makes the wait feel longer, not shorter,
 * because the customer watches the last stage sit still. The final stage has
 * no successor and stays put for as long as generation takes -- which is
 * honest, since "writing" is exactly what is still happening.
 */
export const CONCIERGE_PROGRESS_STAGES: readonly ConciergeProgressStage[] = [
  {
    id: 'reading',
    atMs: 0,
    title: 'Reading your question…',
    subtitle: 'Working out what you are dressing for.',
  },
  {
    id: 'wardrobe',
    atMs: 1_600,
    title: 'Going through your wardrobe…',
    subtitle: 'Gathering the pieces you actually own.',
  },
  {
    id: 'pairing',
    atMs: 4_200,
    title: 'Working out what goes together…',
    subtitle: 'Colour, proportion and the occasion.',
  },
  {
    id: 'writing',
    atMs: 7_500,
    title: 'Writing your recommendation…',
    subtitle: 'Almost there.',
  },
] as const;

/**
 * The stage to show for a given elapsed time.
 *
 * Total and monotonic: it never goes backwards and never runs off the end, so
 * a slow turn parks on the final stage rather than looping or blanking.
 */
export function conciergeProgressStageAt(
  elapsedMs: number,
  stages: readonly ConciergeProgressStage[] = CONCIERGE_PROGRESS_STAGES,
): ConciergeProgressStage {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  let current = stages[0];
  for (const stage of stages) {
    if (elapsed >= stage.atMs) current = stage;
  }
  return current;
}

/**
 * Does this message read as a question about the customer's own wardrobe?
 *
 * Deliberately narrow. A false positive here is the failure mode that matters:
 * it promises a Closet review on a turn that has nothing to do with the Closet.
 * A false negative costs only a plainer spinner, so every ambiguous case is
 * resolved towards the plain one.
 *
 * This is a PRESENTATION hint and nothing else. It never reaches the server,
 * never influences retrieval, and the server's own intent classifier remains
 * the only thing that decides what actually happens.
 */
export function messageReadsAsWardrobeRequest(message: string): boolean {
  if (typeof message !== 'string') return false;
  const text = message.toLowerCase();
  if (text.trim().length < 4) return false;

  // Possession, stated by the customer about clothes. "my closet", "I own",
  // "in my wardrobe", "what do I already have".
  //
  // ONE OPTIONAL ADVERB between subject and verb, for the same reason
  // CON-ABSENCE-006 admits one in the absence guard: "what do I ALREADY own"
  // is how people actually write, and a pattern matching only the adverb-less
  // form silently misses the most natural phrasing of the very question this
  // feature exists to answer.
  const ADV = String.raw`(?:(?:\w+ly|already|actually|currently|still)\s+)?`;
  const possessive =
    /\b(?:my|our)\s+(?:closet|wardrobe|clothes|things|pieces|stuff)\b/.test(text) ||
    new RegExp(String.raw`\bi\s+${ADV}(?:own|have)\b`).test(text) ||
    new RegExp(String.raw`\bdo\s+i\s+${ADV}(?:own|have)\b`).test(text) ||
    new RegExp(String.raw`\bwhat\s+(?:do|should)\s+i\s+${ADV}(?:own|have|wear)\b`).test(text);

  // Asking to be styled FROM what exists, which is the same request phrased as
  // an instruction rather than a possessive.
  const stylingFromOwned =
    /\b(?:what\s+(?:can|could|should)\s+i\s+wear)\b/.test(text) ||
    /\b(?:style|pair|match|wear)\b[^.?!]*\bmy\b/.test(text) ||
    /\b(?:closet|wardrobe)\s+only\b/.test(text) ||
    /\bwithout\s+buying\b/.test(text) ||
    /\bwhat(?:'s| is| am i)?\s+missing\b/.test(text);

  return possessive || stylingFromOwned;
}

/**
 * Should the staged Concierge indicator replace the ordinary Elise one?
 *
 * All three conditions are required, and each removes a different way of
 * claiming something untrue:
 *
 *   conciergeEnabled  the presentation capability is on at all
 *   kPlusActive       the entitlement store says the actor is entitled, so a
 *                     Closet read is at least possible for this turn
 *   the message       reads as a question about their own wardrobe
 */
export function shouldShowConciergeProgress(input: {
  conciergeEnabled: boolean;
  kPlusActive: boolean;
  message: string;
}): boolean {
  if (!input.conciergeEnabled) return false;
  if (!input.kPlusActive) return false;
  return messageReadsAsWardrobeRequest(input.message);
}
