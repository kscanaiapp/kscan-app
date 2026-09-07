'use strict';

/**
 * Reused directly (not reimplemented) from the Match Quality Lab, per
 * spec section 7 ("REUSE PATTERN NOT IMPLEMENTATION... if direct schema
 * reuse would create bad coupling"). The privacy guard is a generic,
 * domain-agnostic key/value-shape scanner with no Match-Quality-specific
 * coupling, and `tools/canonical-product-identity/schema/identitySchema.js`
 * already imports it the same way — this is established repo precedent,
 * not a new coupling this corpus introduces.
 */
module.exports = require('../../fashion-match-quality/schema/privacyGuard');
