/**
 * Where "the scan you just saved" lives, and what the button that opens it says
 * (P-COPY-1).
 *
 * A saved scan is kept in Recent Scans. With the Closet separated into owned
 * wardrobe (CLOSET_SEPARATION_V1) the Closet is a different section the scan does
 * not appear in, so a post-save button labelled "View Closet" that opens Recent
 * Scans names a place the user is not taken to.
 *
 * The label and the route are returned together on purpose: they cannot drift
 * apart again, and the route always names its section explicitly. A bare
 * '/library' resolves to Recent Scans only by default, which is how a Closet
 * label came to sit on a Recent Scans destination without anything noticing
 * (see __tests__/closetRecentScanNavigationSeparation.test.js).
 *
 * Without the separation the library is the single legacy "Style Closet"
 * surface, which ignores the section param, so "View Closet" is still true there.
 *
 * Dependency-free: the caller passes the flag, so this stays loadable by the
 * source-level tests.
 */
export type SavedScanDestination = {
  label: 'View Recent Scans' | 'View Closet';
  route: { pathname: '/library'; params: { section: 'recent' } };
};

export function resolveSavedScanDestination(closetSeparation: boolean): SavedScanDestination {
  return {
    label: closetSeparation ? 'View Recent Scans' : 'View Closet',
    route: { pathname: '/library', params: { section: 'recent' } },
  };
}
