# K Scan Analyze API Contract

This document mirrors the existing K Scan phone app backend contract. **Do not change the payload shape** without coordinating with the main K Scan backend.

## Endpoint

```
POST {KSCAN_BACKEND_URL}/api/analyze
```

Default production URL: `https://kscan-app-1.onrender.com`

## Request

| Field   | Type   | Required | Description                          |
|---------|--------|----------|--------------------------------------|
| `image` | string | yes      | Base64-encoded image (no data URI prefix required) |

```json
{
  "image": "<base64>"
}
```

## Response (success)

Fashion result:

```json
{
  "type": "fashion",
  "result": "string description",
  "metadata": {
    "category": "",
    "color": "",
    "silhouette": ""
  },
  "products": [
    {
      "id": "string",
      "name": "string",
      "retailer": "string",
      "price": "string",
      "imageUrl": "string | null",
      "productUrl": "string | null"
    }
  ]
}
```

Non-fashion result:

```json
{
  "type": "non-fashion",
  "message": "string"
}
```

## Error handling

- Non-2xx: parse JSON when possible; surface `message` or generic error.
- Malformed JSON: treat as server error.
- Network/offline: distinct user-facing message.
- Client timeout (glasses app): **10 seconds** for alpha scaffold.

## Privacy

- Sanitize images (face blur/mask) **before** upload.
- Never log raw images, base64 payloads, or auth tokens.
- No raw unblurred face upload in production.
