// Build 35 convergence — serialize cumulative Packing refinements.
export type RefinementTask = () => Promise<void>;

export function createRefinementSequence(): (task: RefinementTask) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task: RefinementTask) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
