'use strict';

/** Small, pure helpers shared by every module that reports retailer-diversity/concentration numbers (spec sections 19/24/31/32). */

function norm(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'unknown';
}

function distinctRetailerCount(offers) {
  return new Set(offers.map((o) => norm(o.retailer))).size;
}

/** Herfindahl-style concentration index: 1/n at perfect diversity, 1 at full concentration (one retailer owns every slot). */
function concentrationIndex(offers) {
  if (offers.length === 0) return null;
  const counts = new Map();
  for (const o of offers) {
    const r = norm(o.retailer);
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  let sum = 0;
  for (const count of counts.values()) sum += (count / offers.length) ** 2;
  return sum;
}

module.exports = { distinctRetailerCount, concentrationIndex };
