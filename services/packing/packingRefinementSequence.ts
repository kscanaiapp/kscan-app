// Build 35 -- Packing refinements run one after another, in the order sent.
//
// "Different shoes" then, a second later, "no sneakers": the second must be
// applied to the plan the first PRODUCED, so the final plan satisfies both.
// Sending both against the plan on screen would let whichever response lands
// last silently discard the other (BLOCK-PC-Q2-15).
//
// This is ordering, not a new concurrency authority: it never decides WHICH
// result wins -- that stays with the request generation in usePackingPlan and
// the actor epoch in services/actorScope. It only guarantees each refinement
// starts after the previous one has finished, successfully or not. It is not a
// latest-intent queue either: a latest-wins queue would drop "different shoes"
// in favour of "no sneakers", which is exactly the failure being prevented.

export type RefinementTask = () => Promise<void>;

export function createRefinementSequence(): (task: RefinementTask) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task: RefinementTask) => {
    const run = tail.then(task, task);
    // A failed refinement must not wedge every later one behind it.
    tail = run.catch(() => undefined);
    return run;
  };
}
