export interface ScanRoomViewfinderInput {
  windowWidth: number;
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
}

export interface ScanRoomViewfinderSize {
  width: number;
  height: number;
}

export const VIEWFINDER_ASPECT_RATIO: number;
export const VIEWFINDER_HORIZONTAL_INSET: number;
export const MIN_VIEWFINDER_WIDTH: number;

export function estimateReservedChromeHeight(options: {
  insetTop?: number;
  insetBottom?: number;
}): number;

export function computeScanRoomViewfinderSize(
  input: ScanRoomViewfinderInput,
): ScanRoomViewfinderSize;
