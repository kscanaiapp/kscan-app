export type WidthClass = 'compact' | 'regular';
export type HeightClass = 'compact' | 'regular';

export interface GridColumnsOptions {
  compactColumns?: number;
  regularColumns?: number;
  wideColumns?: number;
}

export interface GridCellWidthOptions {
  horizontalPadding?: number;
  gap?: number;
  columns?: number;
}

export interface ResponsiveGridCellWidthOptions extends GridCellWidthOptions, GridColumnsOptions {
  /** Wrapper chrome padding (per side) to subtract on regular widths, e.g. LuxuryScreen's horizontal padding. */
  chromePadding?: number;
}

export const REGULAR_WIDTH_BREAKPOINT: number;
export const WIDE_WIDTH_BREAKPOINT: number;
export const CONTENT_MAX_WIDTH: number;
export const FORM_MAX_WIDTH: number;
export const CONVERSATION_MAX_WIDTH: number;
export const MODAL_MAX_WIDTH: number;
export const MEDIA_MAX_WIDTH: number;
export const RESULTS_WORKSPACE_MAX_WIDTH: number;
export const RESULTS_WORKSPACE_MEDIA_WIDTH: number;
export const RESULTS_WORKSPACE_MIN_WINDOW_WIDTH: number;
export const COMPACT_HEIGHT_BREAKPOINT: number;

export function getWidthClass(windowWidth: number): WidthClass;
export function getHeightClass(windowHeight: number): HeightClass;
export function usesResultsWorkspace(windowWidth: number): boolean;
export function getCenteredHorizontalInset(windowWidth: number, maxWidth?: number, minInset?: number): number;
export function getGridColumns(windowWidth: number, options?: GridColumnsOptions): number;
export function getContentWidth(windowWidth: number, maxWidth?: number): number;
export function computeGridCellWidth(containerWidth: number, options?: GridCellWidthOptions): number;
export function getResponsiveGridCellWidth(windowWidth: number, options?: ResponsiveGridCellWidthOptions): number;
