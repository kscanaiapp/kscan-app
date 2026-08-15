import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import {
  CONTENT_MAX_WIDTH,
  CONVERSATION_MAX_WIDTH,
  FORM_MAX_WIDTH,
  MODAL_MAX_WIDTH,
  chunkIntoRows,
  getContentWidth,
  getGridColumns,
  getResponsiveGridCellWidth,
  getWidthClass,
  type ResponsiveGridCellWidthOptions,
  type WidthClass,
} from '../services/responsiveLayout';

export interface ResponsiveLayout {
  /** Live window width — reacts to rotation and multitasking resize. */
  width: number;
  height: number;
  widthClass: WidthClass;
  /** True at regular width (iPad-class windows); compact preserves iPhone layouts. */
  isRegular: boolean;
  isLandscape: boolean;
  /** Effective centered-column width grids must size against (never wider than contentMaxWidth). */
  contentWidth: number;
  contentMaxWidth: number;
  formMaxWidth: number;
  conversationMaxWidth: number;
  modalMaxWidth: number;
  /** Responsive column count: 2 compact / 3 regular / 4 wide by default. */
  gridColumns: number;
  /**
   * Cell width for flexWrap grids: bit-exact legacy two-column math on
   * compact widths, responsive columns inside the content column on regular.
   */
  gridCellWidth: (options: ResponsiveGridCellWidthOptions) => number;
  /**
   * Split a collection into grid rows using THIS layout's column count.
   *
   * Bound to `gridColumns` on purpose. The iPad grid defect (DEF-045/DEF-068)
   * was precisely a disagreement between the column count cells were sized for
   * and the number placed in a row; taking the count from the same object that
   * produced the width makes that disagreement unrepresentable at the call
   * site. Short final rows are returned unpadded — grid rows are flex rows
   * with a gap and fixed-width cells, so they left-align correctly.
   */
  toGridRows: <T>(items: readonly T[]) => T[][];
}

/**
 * Central responsive-layout signal. All screens derive iPad/regular behavior
 * from window width classes via this hook — no device-model checks anywhere.
 * Values are pure functions of the live window dimensions, so rotation and
 * split-view resizes re-render layouts without touching domain state.
 */
export function useResponsiveLayout(): ResponsiveLayout {
  const { width, height } = useWindowDimensions();

  return useMemo(() => {
    const widthClass = getWidthClass(width);
    const contentWidth = getContentWidth(width);
    const gridColumns = getGridColumns(width);
    return {
      width,
      height,
      widthClass,
      isRegular: widthClass === 'regular',
      isLandscape: width > height,
      contentWidth,
      contentMaxWidth: CONTENT_MAX_WIDTH,
      formMaxWidth: FORM_MAX_WIDTH,
      conversationMaxWidth: CONVERSATION_MAX_WIDTH,
      modalMaxWidth: MODAL_MAX_WIDTH,
      gridColumns,
      gridCellWidth: (options: ResponsiveGridCellWidthOptions) =>
        getResponsiveGridCellWidth(width, options),
      toGridRows: <T,>(items: readonly T[]) => chunkIntoRows(items, gridColumns),
    };
  }, [width, height]);
}
