# K Scan Phone Bridge

TypeScript module for the existing K Scan React Native phone app to pair with Google / Android XR glasses.

## Usage (stub — alpha)

```typescript
import { KScanGoogleGlassesBridge } from './src/KScanGoogleGlassesBridge';

const bridge = new KScanGoogleGlassesBridge({
  supabase: null, // SupabaseClient when wired
  backendUrl: process.env.KSCAN_BACKEND_URL ?? 'https://kscan-app-1.onrender.com',
  onScanResult: (result) => {},
  onDeviceState: (state) => {},
  onError: (error) => {},
});

await bridge.start();
await bridge.stop();
await bridge.sendAuthSession();
await bridge.capturePhotoForGlasses('request-id');
await bridge.openProductOnPhone('https://example.com/product');
```

## Status

All transport layers (Bluetooth, Wi-Fi, Supabase realtime) are **stubs** in Prompt 1.
Message types match `shared/bridge.schema.json`.

## Security

- Never log auth tokens, base64 images, or raw photo payloads.
- Auth session relay is opaque to logs in this module.

## Tests

```bash
npm test
```
