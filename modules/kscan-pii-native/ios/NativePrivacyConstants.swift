import Foundation

enum NativePrivacyConstants {
    static let moduleName = "KScanPiiNative"

    static let sanitizerVersion = "native-face-mask-poc-1.0.0"
    static let detectorVersionAppleVision = "1"

    static let acceptedUriScheme = "file"
    static let acceptedMimeTypes = Set(["image/jpeg", "image/png"])
    static let outputMimeType = "image/png"
    static let outputExtension = "png"

    static let maxWidth = 4096
    static let maxHeight = 4096
    static let maxPixels = 16_777_216

    static let defaultPaddingRatio = 0.15
    static let minPaddingRatio = 0.0
    static let maxPaddingRatio = 0.5

    static let iouDeduplicationThreshold = 0.5

    // Opaque black.
    static let redactionColorR: CGFloat = 0
    static let redactionColorG: CGFloat = 0
    static let redactionColorB: CGFloat = 0
    static let redactionColorA: CGFloat = 1

    static let checksumAlgorithm = "fnv1a-dual-lane-64"

    static let cacheNamespace = "kscan-pii-native"
    static let outputFilePrefix = "kscan-pii-"

    // ── License-plate REGION screening ──────────────────────────────────────
    //
    // A THIRD capability on this module, additive to face masking and person
    // detection and sharing their decoder, normalizer, redactor, verifier and
    // cache manager. It is deliberately NOT text recognition: the detector runs
    // VNDetectTextRectanglesRequest, which reports where text-shaped pixels are
    // and never what they say, so no plate number is ever produced in memory
    // let alone logged, returned or persisted. See IOSPlateDetector.
    //
    // Because the detector cannot read, the ONLY thing separating a plate from
    // any other text in the frame is the shape of its box. Every threshold
    // below is part of that one heuristic, so they live together here rather
    // than being spelled inline at the point each is compared.

    static let plateSanitizerVersion = "native-plate-mask-poc-1.0.0"
    static let plateDetectorImplementation = "vision_text_rectangles"
    /// Vision ships with the OS and exposes no separately versioned text model;
    /// this tracks the pinned request revision, not a downloaded asset.
    static let detectorVersionVisionTextRectangles = "1"

    /// Width:height band a text region must fall inside to be treated as
    /// plate-like.
    ///
    /// Lower bound 2.0: a US passenger plate is 12x6in — exactly 2.0 — and the
    /// glyph run Vision actually boxes inside it is narrower and therefore
    /// wider-looking still (roughly 4:1). 2.0 is the generous floor.
    ///
    /// Upper bound 6.5: European (520x110mm, 4.7:1) and Australian plates and
    /// their glyph runs top out near 6:1. 6.5 leaves headroom without admitting
    /// the long single lines of body text and signage that sit well above 8:1.
    ///
    /// KNOWN MISS, stated rather than hidden: stacked/motorcycle plates are
    /// roughly 7x4in (1.75:1) and fall BELOW this floor, so they are not
    /// screened. Lowering the floor to ~1.7 would cover them at the cost of
    /// masking substantially more non-plate text. That is a product call, not a
    /// code call, so the band is left where the contract specified it.
    static let plateMinAspectRatio = 2.0
    static let plateMaxAspectRatio = 6.5

    /// Minimum fraction of the image WIDTH the region must span. At the
    /// module's 4096px cap this is ~123px; on a 1024px image it is ~31px, which
    /// leaves a seven-character plate about 4px per glyph. Below this the region
    /// carries no legible plate at the resolutions this module accepts.
    ///
    /// This is the threshold most likely to be wrong in the field: "illegible to
    /// a person at 1x" is not the same claim as "unrecoverable", and a
    /// super-resolution model is a different adversary than an eye. Treat 0.03
    /// as a starting point to be tuned against real captures, not as a proof.
    static let plateMinRelativeWidth = 0.03

    /// Secondary guard, in fractions of total pixels. The width floor alone
    /// admits hairline strips — a region 5% of the frame wide and three pixels
    /// tall passes it — so area rejects what width cannot. Deliberately set
    /// BELOW the width floor's own implied area (a 4:1 region at 3% width on a
    /// 4:3 frame is ~0.0003) so that it never silently overrides the width rule
    /// it is meant to supplement.
    static let plateMinRelativeArea = 0.0002

    /// Absolute pixel floors, so a small input image cannot pass the relative
    /// tests with a region too few pixels across to hold a glyph row at all.
    static let plateMinPixelWidth = 24
    static let plateMinPixelHeight = 8

    /// There is deliberately NO upper size bound. An upper bound could only ever
    /// cause a genuine plate to be SKIPPED, and on a privacy boundary the safe
    /// direction of failure is to mask more, not less. The cost is that a very
    /// large wide text region — a sign, a banner, a wordmark across a garment —
    /// is masked as though it were a plate. That is a visible, recoverable
    /// product cost; the reverse is an unrecoverable privacy one.

    /// Plates get more padding than faces (0.15). Vision boxes the glyph RUN,
    /// not the plate, and frequently boxes only part of a run — a state name and
    /// a number can come back as two separate rectangles. The wider pad closes
    /// the border of the plate around the run, and makes the two rectangles of a
    /// split plate overlap enough for the existing IoU dedup to collapse them.
    static let defaultPlatePaddingRatio = 0.25
}
