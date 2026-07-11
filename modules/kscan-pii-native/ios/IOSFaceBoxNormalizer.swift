import Foundation
import CoreGraphics

struct IOSNormalizedFaceBox {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct IOSFaceBoxNormalizer {
    static func normalizeAndPad(
        faces: [IOSFaceRect],
        imageWidth: Int,
        imageHeight: Int,
        paddingRatio: Double
    ) -> [IOSNormalizedFaceBox] {
        let clampedRatio = max(NativePrivacyConstants.minPaddingRatio, min(NativePrivacyConstants.maxPaddingRatio, paddingRatio))

        let candidates = faces.compactMap { face -> IOSNormalizedFaceBox? in
            normalizeSingleBox(face, imageWidth: imageWidth, imageHeight: imageHeight, paddingRatio: clampedRatio)
        }

        let deduplicated = deduplicateBoxes(candidates)

        return deduplicated.sorted {
            if $0.y != $1.y { return $0.y < $1.y }
            if $0.x != $1.x { return $0.x < $1.x }
            if $0.height != $1.height { return $0.height > $1.height }
            return $0.width > $1.width
        }
    }

    private static func normalizeSingleBox(
        _ face: IOSFaceRect,
        imageWidth: Int,
        imageHeight: Int,
        paddingRatio: Double
    ) -> IOSNormalizedFaceBox? {
        guard face.left.isFinite, face.top.isFinite, face.right.isFinite, face.bottom.isFinite else {
            return nil
        }
        guard face.right > face.left, face.bottom > face.top else {
            return nil
        }

        let rawWidth = face.right - face.left
        let rawHeight = face.bottom - face.top
        let centerX = face.left + rawWidth / 2
        let centerY = face.top + rawHeight / 2

        let paddedWidth = rawWidth * CGFloat(1 + 2 * paddingRatio)
        let paddedHeight = rawHeight * CGFloat(1 + 2 * paddingRatio)

        let rawX1 = centerX - paddedWidth / 2
        let rawY1 = centerY - paddedHeight / 2
        let rawX2 = centerX + paddedWidth / 2
        let rawY2 = centerY + paddedHeight / 2

        let x1 = max(0, Int(floor(rawX1)))
        let y1 = max(0, Int(floor(rawY1)))
        let x2 = min(imageWidth, Int(ceil(rawX2)))
        let y2 = min(imageHeight, Int(ceil(rawY2)))

        let width = x2 - x1
        let height = y2 - y1
        guard width > 0, height > 0 else {
            return nil
        }

        return IOSNormalizedFaceBox(x: x1, y: y1, width: width, height: height)
    }

    private static func deduplicateBoxes(_ boxes: [IOSNormalizedFaceBox]) -> [IOSNormalizedFaceBox] {
        let sorted = boxes.sorted { $0.width * $0.height > $1.width * $1.height }
        var kept: [IOSNormalizedFaceBox] = []

        for candidate in sorted {
            let overlaps = kept.contains { existing in
                boxIoU(existing, candidate) >= NativePrivacyConstants.iouDeduplicationThreshold
            }
            if !overlaps {
                kept.append(candidate)
            }
        }

        return kept
    }

    private static func boxIoU(_ a: IOSNormalizedFaceBox, _ b: IOSNormalizedFaceBox) -> Double {
        let intersectionX1 = max(a.x, b.x)
        let intersectionY1 = max(a.y, b.y)
        let intersectionX2 = min(a.x + a.width, b.x + b.width)
        let intersectionY2 = min(a.y + a.height, b.y + b.height)

        let intersectionWidth = max(0, intersectionX2 - intersectionX1)
        let intersectionHeight = max(0, intersectionY2 - intersectionY1)
        let intersectionArea = Int64(intersectionWidth) * Int64(intersectionHeight)

        let areaA = Int64(a.width) * Int64(a.height)
        let areaB = Int64(b.width) * Int64(b.height)
        let unionArea = areaA + areaB - intersectionArea

        guard unionArea > 0 else { return 0 }
        return Double(intersectionArea) / Double(unionArea)
    }
}
