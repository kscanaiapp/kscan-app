import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import {
  CONTENT_MAX_WIDTH,
  CONVERSATION_MAX_WIDTH,
  FORM_MAX_WIDTH,
  MODAL_MAX_WIDTH,
  RESULTS_WORKSPACE_MAX_WIDTH,
  RESULTS_WORKSPACE_MEDIA_WIDTH,
  getContentWidth,
  getGridColumns,
  getHeightClass,
  getResponsiveGridCellWidth,
  getWidthClass,
  usesResultsWorkspace,
  type HeightClass,
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
  heightClass: HeightClass;
  /**
   * True only for genuinely short windows (phone landscape). Use this, not
   * isLandscape, to decide whether to compact vertical chrome: an iPad in
   * landscape is wider than tall but has ample height.
   */
  isCompactHeight: boolean;
  /** Two-pane scan results workspace (image left, analysis right). */
  usesResultsWorkspace: boolean;
  resultsWorkspaceMaxWidth: number;
  /** Hero width inside the workspace's left pane. */
  resultsWorkspaceMediaWidth: number;
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
    const heightClass = getHeightClass(height);
    return {
      width,
      height,
      widthClass,
      isRegular: widthClass === 'regular',
      isLandscape: width > height,
      heightClass,
      isCompactHeight: heightClass === 'compact',
      usesResultsWorkspace: usesResultsWorkspace(width),
      resultsWorkspaceMaxWidth: RESULTS_WORKSPACE_MAX_WIDTH,
      resultsWorkspaceMediaWidth: RESULTS_WORKSPACE_MEDIA_WIDTH,
      contentWidth,
      contentMaxWidth: CONTENT_MAX_WIDTH,
      formMaxWidth: FORM_MAX_WIDTH,
      conversationMaxWidth: CONVERSATION_MAX_WIDTH,
      modalMaxWidth: MODAL_MAX_WIDTH,
      gridColumns,
      gridCellWidth: (options: ResponsiveGridCellWidthOptions) =>
        getResponsiveGridCellWidth(width, options),
    };
  }, [width, height]);
}
