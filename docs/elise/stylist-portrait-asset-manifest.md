# Stylist Portrait Asset Manifest

This document records the ten shipped photorealistic stylist portrait avatars
introduced in the Phase 2 Elise home-layer rollout.

## Ownership and content policy

All portraits are AI-generated, fictional people. No real individual,
celebrity, or identifiable likeness is depicted. Each image was reviewed and
approved to contain:

- No visible brand logos, trademarks, or copyrighted artwork.
- No text, watermarks, or QR codes.
- No sunglasses or accessories that obscure the face in a way that would hurt
  accessibility recognition.
- A neutral-to-warm expression suitable for a premium fashion-tech assistant.

## Gender distribution

The shipped set intentionally contains **6 women and 4 men**. K Scan's primary
audience is women, and this distribution was approved as a deliberate,
non-blocking deviation from an even split.

## Asset inventory

All files live under `assets/stylist-avatars/portraits/` and are required
statically by `constants/stylistIdentity.ts`.

| File | Dimensions | Mode | Size (bytes) | SHA-256 |
|------|------------|------|--------------|---------|
| `stylist_portrait_01.jpg` | 1024×1024 | sRGB/RGB | 283,575 | `1c19a3ab86e561bad3dabb5b6768297b2a953a5d3abdd3c0a90b0cc11fdc3814` |
| `stylist_portrait_02.jpg` | 1024×1024 | sRGB/RGB | 283,707 | `8c6352af31c7c839c588019958f5fcfa6996ea068777eb21cb970ce3936132cd` |
| `stylist_portrait_03.jpg` | 1024×1024 | sRGB/RGB | 269,150 | `8f0a5fbaa1113418a2d2f3296d30b409eaad0ee30da669701238a741ef4baf99` |
| `stylist_portrait_04.jpg` | 1024×1024 | sRGB/RGB | 254,296 | `251d33ab700e2ae328bdc9576c5f7c979b18dd097422affd3ddca3c0a9ab547d` |
| `stylist_portrait_05.jpg` | 1024×1024 | sRGB/RGB | 190,375 | `5240c79b3206afd5ac04be986a3990e490aba55bcc17cc1c067605cf3eef33e5` |
| `stylist_portrait_06.jpg` | 1024×1024 | sRGB/RGB | 134,600 | `8ebbeea72a842f9d88bb67fb570f15bf19bea4ee515dde52c77d044dabadd566` |
| `stylist_portrait_07.jpg` | 1024×1024 | sRGB/RGB | 164,845 | `8c11c4a8297ee48091072d6122cd81a4a24c89fbed1ffcbf3931a8b3d8286db1` |
| `stylist_portrait_08.jpg` | 1024×1024 | sRGB/RGB | 168,068 | `7a0012ed3ec85e47e4ab7fa7ee20f2c09ee3eace377d26314a08efda79e9a688` |
| `stylist_portrait_09.jpg` | 1024×1024 | sRGB/RGB | 197,748 | `69491d2270c09f5a776b84f2a815eda129ddf3b0346db4cc899dfb400cc1e05c` |
| `stylist_portrait_10.jpg` | 1024×1024 | sRGB/RGB | 150,633 | `36a24a6d3438be0ee4a14aa5f0fdb73132cf5e788bd93ef1e5b29a774c54ebd3` |

## Processing pipeline

Raw images were placed in `assets/stylist-avatars/portraits/raw/` as PNGs and
processed by `scripts/process-portrait-avatars.py` using Pillow 12.3.0:

1. Convert to RGB.
2. Strip EXIF metadata.
3. Resize to 1024×1024 pixels with Lanczos resampling.
4. Export as baseline JPEG, quality 90, optimized.

The processor accepts only the ten canonical filenames, refuses missing,
duplicate, or unrelated inputs, and requires `--overwrite` before replacing an
existing processed asset. Reprocessing the preserved approved raw set produces
the exact hashes recorded above.

## Approved replacement record

Portraits 01 and 02 were reprocessed on 2026-07-12 from owner-supplied,
approved replacement PNG sources while retaining their stable IDs. Portraits 03
through 10 were reproduced byte-for-byte unchanged at that time.

Portraits 01 through 04 were refreshed again on 2026-07-23 from owner-approved
replacement sources, again retaining their stable IDs. Portrait 01 shows long
box braids and a black top against a warm neutral boutique background. Portrait
02 shows short hair, a trimmed beard, and a blue polo against a neutral grey
background. All four retain centered facial features and circular-crop-safe
spacing. Portraits 05 through 10 are unchanged. The `accessibilityLabel` values
for 01 and 02 in `constants/stylistIdentity.ts` were updated to match the new
subjects; the prior labels described the superseded images.

## Registry mapping

The canonical IDs `stylist_portrait_01` … `stylist_portrait_10` in
`constants/stylistIdentity.ts` map 1:1 to the files above. Each is
`availability: 'ready'`, `selectable: true`, and `persistable: true`.

## Backend allowlist

The same ten IDs are included in the Phase 2 Supabase migration
`supabase/migrations/20260715000001_expand_stylist_portrait_avatar_allowlist.sql`,
which expands `user_stylist_preferences_avatar_id_check` to exactly sixteen
allowed values (six abstract + ten portrait).

## Rollback / replacement

If any portrait must be replaced, preserve the numeric ID so persisted user
choices remain valid. Update this manifest with the new SHA-256, dimensions,
and file size, and regenerate the processed asset from a new approved raw.
