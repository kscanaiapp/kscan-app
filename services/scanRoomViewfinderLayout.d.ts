export interface ScanRoomViewfinderInput {
  windowWidth: number;
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
}

export interface ScanRoomViewfinderSize {
  width: number;
  height: number;
  /** False when the height budget was too tight to keep the instruction card. */
  showInstructions: boolean;
}

export const VIEWFINDER_ASPECT_RATIO: number;
export const VIEWFINDER_HORIZONTAL_INSET: number;
export const MIN_PREFERRED_VIEWFINDER_WIDTH: number;
export const MIN_RENDER_WIDTH: number;

/** Reserved chrome height assuming the instruction card is shown. */
export function estimateReservedChromeHeight(options: {
  insetTop?: number;
  insetBottom?: number;
}): number;

export function computeScanRoomViewfinderSize(
  input: ScanRoomViewfinderInput,
): ScanRoomViewfinderSize;
