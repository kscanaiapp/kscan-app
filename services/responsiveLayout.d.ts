export type WidthClass = 'compact' | 'regular';

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

export function getWidthClass(windowWidth: number): WidthClass;
export function getGridColumns(windowWidth: number, options?: GridColumnsOptions): number;
export function getContentWidth(windowWidth: number, maxWidth?: number): number;
export function computeGridCellWidth(containerWidth: number, options?: GridCellWidthOptions): number;
export function getResponsiveGridCellWidth(windowWidth: number, options?: ResponsiveGridCellWidthOptions): number;

/**
 * Split a collection into rows of `columns` items. Short final rows are
 * returned as-is rather than padded, because grid rows are flex rows with a
 * gap and fixed-width cells.
 */
export function chunkIntoRows<T>(items: readonly T[], columns: number): T[][];
