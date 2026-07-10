# Routing App Coverage File — K Scan AI

## Overview

This document describes the Routing App Coverage File (`routing-app-coverage.geojson`) for K Scan AI.

**Important:** K Scan AI is a **fashion discovery and scanning application**, not a navigation or routing app. It does not provide turn-by-turn directions, route guidance, or vehicle navigation. The location feature is used solely for **weather-aware styling suggestions** in StyleChat.

This coverage file is provided as a **proactive compliance measure** for App Store review, demonstrating the geographic regions where the app operates.

## File Location

```
assets/routing-app-coverage.geojson
```

## Apple Requirements

Per [Apple's App Store Connect documentation](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information), the Routing App Coverage File:

- Must be in **.geojson format**
- Must contain **only one MultiPolygon element**
- Must specify the geographic regions supported by the app

## File Structure

The file is a valid [GeoJSON (RFC 7946)](https://tools.ietf.org/html/rfc7946) **MultiPolygon** containing 15 bounding boxes representing the supported regions.

```json
{
  "type": "MultiPolygon",
  "coordinates": [
    [ /* United States */ ],
    [ /* Canada */ ],
    [ /* United Kingdom */ ],
    [ /* France */ ],
    [ /* Germany */ ],
    [ /* Italy */ ],
    [ /* Spain */ ],
    [ /* Netherlands */ ],
    [ /* Japan */ ],
    [ /* South Korea */ ],
    [ /* Australia */ ],
    [ /* Brazil */ ],
    [ /* Mexico */ ],
    [ /* Sweden */ ],
    [ /* Switzerland */ ]
  ]
}
```

## Coverage Regions (15 Total)

### Primary Markets (Full Feature Support)

| # | Region | Country Code | Currency | Language |
|---|--------|-------------|----------|----------|
| 1 | United States | US | USD | en-US |
| 2 | Canada | CA | CAD | en-CA |
| 3 | United Kingdom | GB | GBP | en-GB |

### Secondary Markets (Core Features)

| # | Region | Country Code | Currency | Language |
|---|--------|-------------|----------|----------|
| 4 | France | FR | EUR | fr-FR |
| 5 | Germany | DE | EUR | de-DE |
| 6 | Italy | IT | EUR | it-IT |
| 7 | Spain | ES | EUR | es-ES |
| 8 | Netherlands | NL | EUR | nl-NL |
| 9 | Japan | JP | JPY | ja-JP |
| 10 | South Korea | KR | KRW | ko-KR |
| 11 | Australia | AU | AUD | en-AU |

### Tertiary Markets (Limited Support)

| # | Region | Country Code | Currency | Language |
|---|--------|-------------|----------|----------|
| 12 | Brazil | BR | BRL | pt-BR |
| 13 | Mexico | MX | MXN | es-MX |
| 14 | Sweden | SE | SEK | sv-SE |
| 15 | Switzerland | CH | CHF | de-CH |

## App Store Connect Configuration

To upload this file to App Store Connect:

1. Navigate to **App Store Connect > App Information > Platform Version Information**
2. Under **iOS**, click **Routing App Coverage File**
3. Upload `assets/routing-app-coverage.geojson`
4. Save changes

## Info.plist Configuration (Optional)

If Apple requests routing mode declarations, add to `app.json` under `ios.infoPlist`:

```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "MKDirectionsApplicationSupportedModes": [
          "MKDirectionsModePedestrian"
        ]
      }
    }
  }
}
```

**Note:** Since K Scan AI does not provide routing, this is included as a placeholder only. If Apple requests clarification during review, explain that:

1. The app does not provide turn-by-turn navigation
2. Location is only used for weather context in StyleChat
3. The coverage file specifies regions where the app operates

## Validation

To validate the GeoJSON file:

```bash
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('./assets/routing-app-coverage.geojson','utf8')); console.log('Type:', data.type); console.log('Polygons:', data.coordinates.length); console.log('Valid MultiPolygon:', data.type === 'MultiPolygon');"
```

Expected output:
```
Type: MultiPolygon
Polygons: 15
Valid MultiPolygon: true
```

## App Review Notes

If asked about routing capabilities during App Review, use the following response:

> K Scan AI does not provide turn-by-turn navigation or route guidance. The app is a fashion discovery tool that uses camera scanning and AI analysis to help users explore style options. The Routing App Coverage File specifies the geographic regions where the app is available and supported. Location data, when used, is solely for weather-aware styling suggestions in the StyleChat feature and is not used for navigation purposes.

## Maintenance

When expanding to new markets:

1. Add a new polygon to the MultiPolygon coordinates array
2. Update this documentation
3. Update `store.config.json` with localized metadata if applicable
4. Re-upload the file to App Store Connect

## Related Files

- `app.json` — iOS app configuration
- `store.config.json` — App Store metadata
- `services/weather/weatherStylingContext.ts` — Weather context implementation

## References

- [Apple App Store Connect — Routing App Coverage File](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
- [Apple Product Page — App Information](https://developer.apple.com/app-store/product-page/)
- [GeoJSON Specification (RFC 7946)](https://tools.ietf.org/html/rfc7946)
