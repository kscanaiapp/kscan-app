package expo.modules.kscanpiinative

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

data class NormalizedFaceBox(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val paddedWidth: Int,
    val paddedHeight: Int,
)

object AndroidFaceBoxNormalizer {
    fun normalizeAndPad(
        faces: List<FaceRect>,
        imageWidth: Int,
        imageHeight: Int,
        paddingRatio: Double,
    ): List<NormalizedFaceBox> {
        val clampedRatio = paddingRatio.coerceIn(
            NativePrivacyConstants.MIN_PADDING_RATIO,
            NativePrivacyConstants.MAX_PADDING_RATIO,
        )

        val candidates = faces.mapNotNull { face ->
            normalizeSingleBox(face, imageWidth, imageHeight, clampedRatio)
        }

        val deduplicated = deduplicateBoxes(candidates)

        return deduplicated.sortedWith(
            compareBy<NormalizedFaceBox> { it.y }
                .thenBy { it.x }
                .thenByDescending { it.height }
                .thenByDescending { it.width },
        )
    }

    private fun normalizeSingleBox(
        face: FaceRect,
        imageWidth: Int,
        imageHeight: Int,
        paddingRatio: Double,
    ): NormalizedFaceBox? {
        if (!face.left.isFinite() || !face.top.isFinite() || !face.right.isFinite() || !face.bottom.isFinite()) {
            return null
        }
        if (face.right <= face.left || face.bottom <= face.top) {
            return null
        }

        val rawWidth = face.right - face.left
        val rawHeight = face.bottom - face.top
        val centerX = face.left + rawWidth / 2f
        val centerY = face.top + rawHeight / 2f

        val paddedWidth = rawWidth * (1f + 2 * paddingRatio.toFloat())
        val paddedHeight = rawHeight * (1f + 2 * paddingRatio.toFloat())

        val rawX1 = centerX - paddedWidth / 2f
        val rawY1 = centerY - paddedHeight / 2f
        val rawX2 = centerX + paddedWidth / 2f
        val rawY2 = centerY + paddedHeight / 2f

        // Outward rounding: floor start, ceil end.
        val x1 = max(0, floor(rawX1).toInt())
        val y1 = max(0, floor(rawY1).toInt())
        val x2 = min(imageWidth, ceil(rawX2).toInt())
        val y2 = min(imageHeight, ceil(rawY2).toInt())

        val width = x2 - x1
        val height = y2 - y1
        if (width <= 0 || height <= 0) {
            return null
        }

        return NormalizedFaceBox(
            x = x1,
            y = y1,
            width = width,
            height = height,
            paddedWidth = ceil(paddedWidth).toInt(),
            paddedHeight = ceil(paddedHeight).toInt(),
        )
    }

    private fun deduplicateBoxes(boxes: List<NormalizedFaceBox>): List<NormalizedFaceBox> {
        // Sort by area descending so larger boxes are preferred.
        val sorted = boxes.sortedByDescending { it.width * it.height }
        val kept = mutableListOf<NormalizedFaceBox>()

        for (candidate in sorted) {
            val overlaps = kept.any { existing ->
                boxIoU(existing, candidate) >= NativePrivacyConstants.IOU_DEDUPLICATION_THRESHOLD
            }
            if (!overlaps) {
                kept.add(candidate)
            }
        }

        return kept
    }

    private fun boxIoU(a: NormalizedFaceBox, b: NormalizedFaceBox): Double {
        val intersectionX1 = max(a.x, b.x)
        val intersectionY1 = max(a.y, b.y)
        val intersectionX2 = min(a.x + a.width, b.x + b.width)
        val intersectionY2 = min(a.y + a.height, b.y + b.height)

        val intersectionWidth = max(0, intersectionX2 - intersectionX1)
        val intersectionHeight = max(0, intersectionY2 - intersectionY1)
        val intersectionArea = intersectionWidth.toLong() * intersectionHeight.toLong()

        val areaA = a.width.toLong() * a.height.toLong()
        val areaB = b.width.toLong() * b.height.toLong()
        val unionArea = areaA + areaB - intersectionArea

        if (unionArea <= 0) return 0.0
        return intersectionArea.toDouble() / unionArea.toDouble()
    }
}
