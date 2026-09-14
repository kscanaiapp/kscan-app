#!/usr/bin/env node
/**
 * How often does a CONFIRMED Packing gap actually occur? (continuation brief §9)
 *
 * The confirmed-gap Commerce action only appears on a gap Packing has confirmed,
 * so its reachability depends on how often that happens. This measures it over a
 * bounded set of representative trip requirements, through the REAL deriver
 * (`derivePackingCoverageGaps`), rather than assuming the action will be common.
 *
 * THIS IS A FIXTURE MEASUREMENT, NOT A POPULATION CLAIM. Twelve synthetic
 * wardrobes are not a sample of anything. The number is here so the activation
 * is described honestly -- and so that if it comes out low, the temptation to
 * raise certainty for the sake of activation frequency is visible and refused.
 *
 *   node tools/activation/packingGapIncidence.js
 *   node tools/activation/packingGapIncidence.js --json
 */
'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));
const { derivePackingCoverageGaps } = chat('packingGaps.ts');

/** A Closet item reduced to the facts the gap deriver may read. */
const item = (layeringRole, band = null) => ({ layeringRole, band });

/**
 * Twelve representative trips.
 *
 * Deliberately mixed: wardrobes with complete metadata (where a gap can be
 * CONFIRMED), wardrobes with unstated formality (where Packing can only say
 * "I can't tell", i.e. UNCONFIRMED), and wardrobes that cover everything.
 */
const SCENARIOS = [
  {
    id: 'T01_city_break_no_outer',
    note: 'Three days, no outerwear in the Closet at all.',
    requiredRoles: ['base', 'bottom', 'shoe', 'outer'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2, outer: 0 },
    closetItems: [item('base', 'casual'), item('bottom', 'casual'), item('shoe', 'casual')],
    slots: [],
    forecastSummary: null,
    statedConditions: [],
  },
  {
    id: 'T02_wedding_casual_shoes',
    note: 'Formal event; every shoe is stated casual.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2 },
    closetItems: [item('shoe', 'casual'), item('base', 'smart'), item('bottom', 'smart')],
    slots: [{ slotId: 's1', activity: 'formal_event', coverage: 'uncovered', missing: ['shoe'], strict: true }],
    forecastSummary: null,
    statedConditions: [],
  },
  {
    id: 'T03_wedding_unknown_shoes',
    note: 'Formal event; shoe formality is NOT stated in the Closet.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2 },
    closetItems: [item('shoe', null), item('base', 'smart'), item('bottom', 'smart')],
    slots: [{ slotId: 's1', activity: 'formal_event', coverage: 'uncovered', missing: ['shoe'], strict: true }],
    forecastSummary: null,
    statedConditions: [],
  },
  {
    id: 'T04_rain_forecast_no_shell',
    note: 'Forecast says rain; no rain layer owned.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2 },
    closetItems: [item('base', 'casual'), item('bottom', 'casual'), item('shoe', 'casual')],
    slots: [],
    forecastSummary: 'Rain showers most of the week.',
    statedConditions: [],
  },
  {
    id: 'T05_stated_rain_no_shell',
    note: 'Traveller said it will rain; no rain layer owned.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2 },
    closetItems: [item('base', 'casual'), item('bottom', 'casual'), item('shoe', 'casual')],
    slots: [],
    forecastSummary: null,
    statedConditions: ['rain'],
  },
  {
    id: 'T06_cold_no_warm_layer',
    note: 'Cold stated; no mid layer owned.',
    requiredRoles: ['base', 'bottom', 'shoe', 'mid'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2, mid: 0 },
    closetItems: [item('base', 'casual'), item('bottom', 'casual'), item('shoe', 'casual')],
    slots: [],
    forecastSummary: null,
    statedConditions: ['cold'],
  },
  {
    id: 'T07_well_covered',
    note: 'Everything required is owned and stated.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 6, bottom: 4, shoe: 3 },
    closetItems: [item('base', 'smart'), item('bottom', 'smart'), item('shoe', 'smart')],
    slots: [],
    forecastSummary: 'Mild and dry.',
    statedConditions: [],
  },
  {
    id: 'T08_wedding_unknown_main',
    note: 'Formal event; nothing states formality for tops or bottoms.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2 },
    closetItems: [item('shoe', 'formal'), item('base', null), item('bottom', null)],
    slots: [{ slotId: 's1', activity: 'formal_event', coverage: 'uncovered', missing: ['base'], strict: true }],
    forecastSummary: null,
    statedConditions: [],
  },
  {
    id: 'T09_beach_no_shoes',
    note: 'No shoes owned at all.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 5, bottom: 3, shoe: 0 },
    closetItems: [item('base', 'casual'), item('bottom', 'casual')],
    slots: [],
    forecastSummary: 'Hot and dry.',
    statedConditions: [],
  },
  {
    id: 'T10_census_incomplete',
    note: 'The Closet census never completed — Packing may assert nothing.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 0, bottom: 0, shoe: 0 },
    closetItems: [],
    slots: [],
    forecastSummary: null,
    statedConditions: [],
    censusComplete: false,
  },
  {
    id: 'T11_snow_no_shell',
    note: 'Snow forecast; no outer layer owned.',
    requiredRoles: ['base', 'bottom', 'shoe', 'outer'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2, outer: 0 },
    closetItems: [item('base', 'casual'), item('bottom', 'casual'), item('shoe', 'casual')],
    slots: [],
    forecastSummary: 'Snow expected midweek.',
    statedConditions: [],
  },
  {
    id: 'T12_formal_and_rain',
    note: 'Formal event AND rain, with casual shoes and no shell.',
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetRoleCensus: { base: 4, bottom: 3, shoe: 2 },
    closetItems: [item('shoe', 'casual'), item('base', 'smart'), item('bottom', 'smart')],
    slots: [{ slotId: 's1', activity: 'formal_event', coverage: 'uncovered', missing: ['shoe'], strict: true }],
    forecastSummary: 'Heavy rain on Friday.',
    statedConditions: [],
  },
];

function run() {
  const rows = SCENARIOS.map((scenario) => {
    const gaps = derivePackingCoverageGaps({
      censusComplete: scenario.censusComplete !== false,
      closetRoleCensus: scenario.closetRoleCensus,
      requiredRoles: scenario.requiredRoles,
      closetItems: scenario.closetItems,
      slots: scenario.slots,
      forecastSummary: scenario.forecastSummary,
      statedConditions: scenario.statedConditions,
    });
    return {
      id: scenario.id,
      note: scenario.note,
      gaps: gaps.map((g) => ({ code: g.code, certainty: g.certainty, source: g.source, label: g.label })),
    };
  });

  const all = rows.flatMap((r) => r.gaps);
  const confirmed = all.filter((g) => g.certainty === 'confirmed');
  const unconfirmed = all.filter((g) => g.certainty === 'unconfirmed');
  const tripsWithConfirmed = rows.filter((r) => r.gaps.some((g) => g.certainty === 'confirmed'));

  return {
    scope: 'ENGINEERING FIXTURE MEASUREMENT — NOT A POPULATION CLAIM',
    PACKING_FIXTURE_TRIPS: rows.length,
    PACKING_FIXTURE_GAPS_TOTAL: all.length,
    PACKING_FIXTURE_CONFIRMED: confirmed.length,
    PACKING_FIXTURE_UNCONFIRMED: unconfirmed.length,
    PACKING_FIXTURE_CONFIRMED_RATE: all.length
      ? Number((confirmed.length / all.length).toFixed(3))
      : 0,
    PACKING_FIXTURE_TRIPS_WITH_A_CONFIRMED_GAP: tripsWithConfirmed.length,
    rows,
    limitation:
      'Confirmed certainty requires stated Closet metadata (formality band, role). Sparse metadata produces UNCONFIRMED gaps, which carry no shopping action by design. Certainty is never raised to increase activation frequency.',
  };
}

module.exports = { run, SCENARIOS };

if (require.main === module) {
  const report = run();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const row of report.rows) {
      const summary = row.gaps.length
        ? row.gaps.map((g) => `${g.code}[${g.certainty}]`).join(', ')
        : '(none)';
      console.log(`${row.id.padEnd(28)} ${summary}`);
    }
    console.log('');
    for (const key of Object.keys(report)) {
      if (key === 'rows' || key === 'limitation' || key === 'scope') continue;
      console.log(`${key} = ${report[key]}`);
    }
    console.log(`\n${report.scope}\n${report.limitation}`);
  }
}
