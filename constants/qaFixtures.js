/**
 * QA fixture registry — PRODUCTION STUB.
 *
 * This file deliberately contains NO `require()` of any fixture image, so the
 * eight files under assets/qa_fixtures/ are absent from the production module
 * graph and therefore absent from the production export.
 *
 * WHY A SEPARATE MODULE RATHER THAN A __DEV__ GUARD:
 * a `__DEV__ ? [require(...)] : []` ternary was tried and does NOT work. Metro
 * collects asset dependencies from the AST while building the module graph;
 * the dead branch is eliminated later, at minification. The requires are
 * therefore still collected and the images still ship. That was confirmed
 * empirically — a production export of the guarded source contained all eight
 * fixture hashes.
 *
 * The development registry lives in ./qaFixtures.dev.js, which Metro resolves
 * ONLY in development, via the `dev.js` sourceExt registered in
 * metro.config.js. In a production bundle that file is never resolved, so
 * neither it nor the images it references enter the graph.
 *
 * Verified by __tests__/qaFixturesProductionGate.test.js and by the export-level
 * detector scripts/check-export-fixture-containment.js.
 */
export const QA_FIXTURES = [];
