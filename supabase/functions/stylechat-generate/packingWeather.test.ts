// K+ Packing Intelligence V1 — weather enrichment certification (B3).
//
// Deterministic: every network call is an injected stub, and the clock is
// injected too. Nothing here reaches Open-Meteo.
//
// The claims:
//   1. Weather NEVER blocks a plan. Every failure mode returns null.
//   2. A summary is only ever reported when one was actually received.
//   3. SEASONAL cannot be emitted, because no seasonal authority exists.
//   4. Ten refinements of one trip are one weather call.
//   5. Only the destination string leaves the function.

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  FORECAST_HORIZON_DAYS,
  clearPackingWeatherCache,
  fetchDestinationForecast,
  geocodeDestination,
  isWithinForecastHorizon,
  packingWeatherCacheKey,
  resolvePackingWeather,
} from './packingWeather.ts';

const NOW = Date.parse('2026-09-01T12:00:00Z');
const now = () => NOW;

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

const GEOCODE_OK = { results: [{ latitude: 25.7743, longitude: -80.1937, name: 'Miami' }] };
const FORECAST_OK = {
  daily: {
    temperature_2m_max: [88, 89, 87, 90, 88],
    temperature_2m_min: [77, 78, 76, 78, 77],
    weather_code: [1, 95, 2, 3, 80],
  },
};

/** Records every URL requested so privacy claims can be asserted, not assumed. */
function stubFetch(handlers: Array<(url: string) => Response | Promise<Response>>) {
  const calls: string[] = [];
  let index = 0;
  const impl = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

Deno.test('horizon: a trip inside the provider window is forecastable', () => {
  assertEquals(isWithinForecastHorizon('2026-09-12', '2026-09-16', NOW), true);
  assertEquals(isWithinForecastHorizon('2026-09-01', '2026-09-03', NOW), true);
});

Deno.test('horizon: a trip beyond the window, or already over, is not', () => {
  const beyond = new Date(NOW + (FORECAST_HORIZON_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
  const beyondEnd = new Date(NOW + (FORECAST_HORIZON_DAYS + 8) * 86_400_000).toISOString().slice(0, 10);
  assertEquals(isWithinForecastHorizon(beyond, beyondEnd, NOW), false);
  assertEquals(isWithinForecastHorizon('2026-08-01', '2026-08-05', NOW), false);
  assertEquals(isWithinForecastHorizon('not-a-date', '2026-09-16', NOW), false);
});

Deno.test('resolver: a good geocode and forecast yields a FORECAST summary', async () => {
  clearPackingWeatherCache();
  const { impl, calls } = stubFetch([
    () => jsonResponse(GEOCODE_OK),
    () => jsonResponse(FORECAST_OK),
  ]);
  const result = await resolvePackingWeather({
    destination: 'Miami',
    startDate: '2026-09-12',
    endDate: '2026-09-16',
    fetchImpl: impl,
    now,
  });
  assert(result);
  assertEquals(result!.provenance, 'FORECAST');
  assertStringIncludes(result!.summary, 'highs 87-90F');
  assertStringIncludes(result!.summary, 'lows near 76F');
  assertStringIncludes(result!.summary, 'rain on 2 of 5 days');
  assertEquals(calls.length, 2);
});

Deno.test('resolver: only the destination leaves the function, and coordinates are rounded', async () => {
  clearPackingWeatherCache();
  const { impl, calls } = stubFetch([
    () => jsonResponse(GEOCODE_OK),
    () => jsonResponse(FORECAST_OK),
  ]);
  await resolvePackingWeather({
    destination: 'Miami',
    startDate: '2026-09-12',
    endDate: '2026-09-16',
    fetchImpl: impl,
    now,
  });
  const joined = calls.join(' ');
  // No identity, no wardrobe, no note.
  assert(!/user|uid|token|closet|note|brand/i.test(joined), 'no identity or wardrobe data may be sent');
  // Latitude arrives at 4 decimal places and must be sent at 2.
  assertStringIncludes(calls[1], 'latitude=25.77');
  assert(!calls[1].includes('25.7743'), 'coordinates must be rounded before use');
});

Deno.test('resolver: SEASONAL can never be emitted — there is no seasonal authority', async () => {
  clearPackingWeatherCache();
  // Every reachable shape: good, beyond horizon, no geocode, empty forecast.
  const beyond = new Date(NOW + 40 * 86_400_000).toISOString().slice(0, 10);
  const cases = [
    { destination: 'Miami', start: '2026-09-12', end: '2026-09-16', handlers: [() => jsonResponse(GEOCODE_OK), () => jsonResponse(FORECAST_OK)] },
    { destination: 'Miami', start: beyond, end: beyond, handlers: [() => jsonResponse(GEOCODE_OK), () => jsonResponse(FORECAST_OK)] },
    { destination: 'Nowhere', start: '2026-09-12', end: '2026-09-16', handlers: [() => jsonResponse({ results: [] })] },
    { destination: 'Miami', start: '2026-09-12', end: '2026-09-16', handlers: [() => jsonResponse(GEOCODE_OK), () => jsonResponse({ daily: {} })] },
  ];
  for (const [index, testCase] of cases.entries()) {
    clearPackingWeatherCache();
    const { impl } = stubFetch(testCase.handlers);
    const result = await resolvePackingWeather({
      destination: `${testCase.destination}-${index}`,
      startDate: testCase.start,
      endDate: testCase.end,
      fetchImpl: impl,
      now,
    });
    assert(result === null || result.provenance === 'FORECAST', 'SEASONAL is unreachable by construction');
  }
});

Deno.test('resolver: a geocode miss, a provider error and a thrown fetch all yield null', async () => {
  const failures: Array<Array<(url: string) => Response | Promise<Response>>> = [
    [() => jsonResponse({ results: [] })],
    [() => jsonResponse({}, false)],
    [() => jsonResponse(GEOCODE_OK), () => jsonResponse({}, false)],
    [
      () => {
        throw new Error('network down');
      },
    ],
  ];
  for (const [index, handlers] of failures.entries()) {
    clearPackingWeatherCache();
    const { impl } = stubFetch(handlers);
    const result = await resolvePackingWeather({
      destination: `Failure-${index}`,
      startDate: '2026-09-12',
      endDate: '2026-09-16',
      fetchImpl: impl,
      now,
    });
    assertEquals(result, null, `failure mode ${index} must not produce weather`);
  }
});

Deno.test('resolver: an all-null forecast window is no data, never a confident summary', async () => {
  clearPackingWeatherCache();
  const { impl } = stubFetch([
    () => jsonResponse(GEOCODE_OK),
    () =>
      jsonResponse({
        daily: {
          temperature_2m_max: [null, null],
          temperature_2m_min: [null, null],
          weather_code: [null, null],
        },
      }),
  ]);
  const result = await resolvePackingWeather({
    destination: 'Miami',
    startDate: '2026-09-12',
    endDate: '2026-09-16',
    fetchImpl: impl,
    now,
  });
  assertEquals(result, null);
});

Deno.test('cache: ten refinements of one trip are one weather call', async () => {
  clearPackingWeatherCache();
  const { impl, calls } = stubFetch([
    () => jsonResponse(GEOCODE_OK),
    () => jsonResponse(FORECAST_OK),
  ]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await resolvePackingWeather({
      destination: 'Miami',
      startDate: '2026-09-12',
      endDate: '2026-09-16',
      fetchImpl: impl,
      now,
    });
    assert(result);
  }
  assertEquals(calls.length, 2, 'geocode once, forecast once');
});

Deno.test('cache: a miss is cached too, so an unanswerable trip is not re-asked', async () => {
  clearPackingWeatherCache();
  const { impl, calls } = stubFetch([() => jsonResponse({ results: [] })]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await resolvePackingWeather({
      destination: 'Atlantis',
      startDate: '2026-09-12',
      endDate: '2026-09-16',
      fetchImpl: impl,
      now,
    });
  }
  assertEquals(calls.length, 1);
});

Deno.test('cache: changing the destination or the dates is a different question', () => {
  const base = packingWeatherCacheKey('Miami', '2026-09-12', '2026-09-16');
  assertEquals(base, packingWeatherCacheKey('  MIAMI, ', '2026-09-12', '2026-09-16'));
  assert(base !== packingWeatherCacheKey('Milan', '2026-09-12', '2026-09-16'));
  assert(base !== packingWeatherCacheKey('Miami', '2026-09-13', '2026-09-16'));
  assert(base !== packingWeatherCacheKey('Miami', '2026-09-12', '2026-09-20'));
});

Deno.test('geocode: an out-of-range or non-numeric coordinate is rejected', async () => {
  for (const results of [
    [{ latitude: 999, longitude: 0 }],
    [{ latitude: 0, longitude: 999 }],
    [{ latitude: 'north', longitude: 0 }],
    [{}],
  ]) {
    const { impl } = stubFetch([() => jsonResponse({ results })]);
    assertEquals(await geocodeDestination('Somewhere', impl), null);
  }
});

Deno.test('forecast: a body with no daily block is not a forecast', async () => {
  const { impl } = stubFetch([() => jsonResponse({ hourly: {} })]);
  const summary = await fetchDestinationForecast({
    latitude: 25.77,
    longitude: -80.19,
    startDate: '2026-09-12',
    endDate: '2026-09-16',
    fetchImpl: impl,
  });
  assertEquals(summary, null);
});

Deno.test('forecast: a dry window says so rather than inventing rain', async () => {
  const { impl } = stubFetch([
    () =>
      jsonResponse({
        daily: {
          temperature_2m_max: [70, 70],
          temperature_2m_min: [55, 55],
          weather_code: [0, 1],
        },
      }),
  ]);
  const summary = await fetchDestinationForecast({
    latitude: 48.85,
    longitude: 2.35,
    startDate: '2026-09-12',
    endDate: '2026-09-13',
    fetchImpl: impl,
  });
  assert(summary);
  assertStringIncludes(summary!, 'highs around 70F');
  assertStringIncludes(summary!, 'mostly dry');
});

// ─────────────────────────────────────────────────────────────────────────────
// PK-002 — THE FORECAST MUST NAME THE PLACE IT IS ACTUALLY FOR
//
// `count=1` means the geocoder returns one candidate and it is used silently.
// Probed against the live public endpoint: "Springfield" resolves to Missouri,
// "Portland" to Oregon, and "Georgia" to the COUNTRY (41.99, 43.49) rather than
// the US state. The traveller saw only the string they typed above a confident
// forecast line, so a wrong city was undetectable while it drove real garment
// choices. The resolved place is now carried through and shown.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('PK-002: the geocoder label is built from the PROVIDER fields, not the typed string', async () => {
  const { impl } = stubFetch([
    () =>
      jsonResponse({
        results: [
          { latitude: 37.21533, longitude: -93.29824, name: 'Springfield', admin1: 'Missouri', country_code: 'US' },
        ],
      }),
  ]);
  // The traveller typed a bare "Springfield"; the provider chose Missouri.
  const coords = await geocodeDestination('Springfield', impl);
  assertEquals(coords?.label, 'Springfield, Missouri, US');
});

Deno.test('PK-002: a resolved forecast carries the place it is for', async () => {
  clearPackingWeatherCache();
  const { impl } = stubFetch([
    () =>
      jsonResponse({
        results: [{ latitude: 42.0, longitude: 43.5, name: 'Georgia', country_code: 'GE' }],
      }),
    () => jsonResponse(FORECAST_OK),
  ]);
  // "Georgia" the country, not the US state -- the case a traveller is least
  // able to spot and the one that changes a suitcase most.
  const result = await resolvePackingWeather({
    destination: 'Georgia',
    startDate: '2026-09-02',
    endDate: '2026-09-05',
    fetchImpl: impl,
    now,
  });
  assertEquals(result?.provenance, 'FORECAST');
  assertEquals(result?.resolvedLocation, 'Georgia, GE');
});

Deno.test('PK-002: a geocode with no usable name resolves coordinates but claims no place', async () => {
  clearPackingWeatherCache();
  const { impl } = stubFetch([
    () => jsonResponse({ results: [{ latitude: 51.5, longitude: -0.13 }] }),
    () => jsonResponse(FORECAST_OK),
  ]);
  const result = await resolvePackingWeather({
    destination: 'Nowhere In Particular',
    startDate: '2026-09-02',
    endDate: '2026-09-05',
    fetchImpl: impl,
    now,
  });
  // Never falls back to echoing the typed destination: that would manufacture
  // exactly the false confirmation this finding is about.
  assertEquals(result?.resolvedLocation, null);
});

Deno.test('PK-002: the UI names the resolved place on the forecast line, and only there', async () => {
  const source = await Deno.readTextFile(
    new URL('../../../components/packing/PackingPlanView.tsx', import.meta.url),
  );
  assertStringIncludes(source, 'plan.weather.resolvedLocation');
  // UNAVAILABLE has no place to name, and must not gain one.
  assertStringIncludes(source, "'Weather unavailable — planned from your trip and occasions'");
});
