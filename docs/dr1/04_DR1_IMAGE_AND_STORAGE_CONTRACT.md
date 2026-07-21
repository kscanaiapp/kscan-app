# 04 — DR-1 Image and Storage Contract

## Priority (unchanged)

1. Owner-scoped storage bucket/path  
2. Approved remote HTTPS product URL  
3. Local URI (upload then store)  
4. Explicit none  

## Hard rules

- Signed Supabase `/storage/v1/object/sign/` URLs are **never** durable identity.
- Never persist signed URLs as `image_url` identity.
- Storage XOR remote column write remains.
- Upload failure fail-open to prior usable path where possible; no usable source → user-facing error.
- Unauthorized paths fail closed at shared-image Edge Function.

## Saved Scan cloud images

`SAVED_SCAN_CLOUD_IMAGES_V1` default OFF. Not activated for current testers.  
Next approved client build required before claiming cross-device image durability.
