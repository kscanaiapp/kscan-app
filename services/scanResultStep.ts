/**
 * Whether the scan result sheet is on the "choose a garment" (confirmation) step.
 *
 * Detection returns candidates, the user picks one and taps Find Matches, and the
 * selected garment's analysis arrives. That analysis deliberately keeps the
 * detection's candidate list so the chosen garment stays labelled in context, so
 * "candidates are present" cannot by itself mean "still choosing". The selected
 * result carries its own marker (`selectedItemResult`); once it is on screen the
 * step is over: the footer must stop offering Find Matches (it would re-run the
 * same analysis) and the scan-scoped actions (Save / View Closet, Ask Elise, Add
 * to Dressing Room) are right again, because one garment is on screen.
 *
 * Exact `=== true`: a result that merely looks truthy must never end the step and
 * unlock actions that act on the whole scan.
 *
 * Pure, and followed by ScanResultV2 per __tests__/scanResultStep.test.js.
 */
export type CandidateConfirmationStepInput = {
  candidateCount: number;
  selectedItemResult?: boolean | null;
};

export function isCandidateConfirmationStep(input: CandidateConfirmationStepInput): boolean {
  return input.candidateCount > 0 && input.selectedItemResult !== true;
}
