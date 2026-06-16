// Luxury shared UI components for the K Scan frontend polish pass.
// These are built on top of the LUXURY / FONTS tokens in constants/theme.ts
// and are intentionally isolated from existing shared components until they
// are adopted screen-by-screen.

export { KScanHeader, type KScanHeaderProps } from './KScanHeader';
export { LuxuryScreen, type LuxuryScreenProps } from './LuxuryScreen';
export {
  LuxuryButton,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
  type LuxuryButtonProps,
} from './LuxuryButton';
export { SectionHeader, type SectionHeaderProps } from './SectionHeader';
export { ProductCard, type ProductCardProps } from './ProductCard';
export { PrivacyFooter, type PrivacyFooterProps } from './PrivacyFooter';
