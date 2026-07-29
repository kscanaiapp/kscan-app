const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Development-only module resolution.
//
// Registering the `dev.js` source extension ahead of the defaults makes Metro
// prefer `constants/qaFixtures.dev.js` over `constants/qaFixtures.js` when
// bundling for development. A production bundle never registers the extension,
// so the dev registry — and every QA fixture image it requires — is absent from
// the production module graph.
//
// This is what actually keeps QA fixtures out of a release build. A __DEV__
// ternary does not: Metro collects asset dependencies while building the module
// graph, and the dead branch is only eliminated later at minification, so the
// requires are still collected and the images still ship.
if (process.env.NODE_ENV !== 'production') {
  config.resolver.sourceExts = ['dev.js', ...config.resolver.sourceExts];
}

module.exports = config;
