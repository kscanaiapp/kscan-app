package expo.modules.kscanpiinative

import org.junit.Test
import org.junit.Assert.*

class NativePrivacyUnitTests {
    @Test
    fun constantsMatchParitySpecification() {
        assertEquals("native-face-mask-poc-1.0.0", NativePrivacyConstants.SANITIZER_VERSION)
        assertEquals(4096, NativePrivacyConstants.MAX_WIDTH)
        assertEquals(4096, NativePrivacyConstants.MAX_HEIGHT)
        assertEquals(16_777_216L, NativePrivacyConstants.MAX_PIXELS)
        assertEquals(0.15, NativePrivacyConstants.DEFAULT_PADDING_RATIO, 0.0001)
        assertEquals(0.0, NativePrivacyConstants.MIN_PADDING_RATIO, 0.0001)
        assertEquals(0.5, NativePrivacyConstants.MAX_PADDING_RATIO, 0.0001)
        assertEquals(0.5, NativePrivacyConstants.IOU_DEDUPLICATION_THRESHOLD, 0.0001)
        assertTrue(NativePrivacyConstants.ACCEPTED_MIME_TYPES.contains("image/jpeg"))
        assertTrue(NativePrivacyConstants.ACCEPTED_MIME_TYPES.contains("image/png"))
        assertEquals("image/png", NativePrivacyConstants.OUTPUT_MIME_TYPE)
        assertEquals("fnv1a-dual-lane-64", NativePrivacyConstants.CHECKSUM_ALGORITHM)
    }

    @Test
    fun checksumMatchesParityVectors() {
        assertEquals("811c9dc59e3779b900000000", AndroidOutputVerifier.checksumBuffer(byteArrayOf()))
        assertEquals("050c5d1f53a3c66700000001", AndroidOutputVerifier.checksumBuffer(byteArrayOf(0)))
        assertEquals("1a47e90bc574722700000003", AndroidOutputVerifier.checksumBuffer(byteArrayOf(97, 98, 99)))
        assertEquals("e3160fb1516de17c00000004", AndroidOutputVerifier.checksumBuffer(byteArrayOf(255.toByte(), 255.toByte(), 255.toByte(), 255.toByte())))
        assertEquals("dc9546585364785b00000004", AndroidOutputVerifier.checksumBuffer(byteArrayOf(0, 0, 0, 255.toByte())))
    }

    @Test
    fun boxNormalizerPadsAndRoundsOutward() {
        val faces = listOf(FaceRect(4f, 4f, 6f, 6f))
        val result = AndroidFaceBoxNormalizer.normalizeAndPad(faces, 10, 10, 0.5)
        assertEquals(1, result.size)
        assertEquals(3, result[0].x)
        assertEquals(3, result[0].y)
        assertEquals(4, result[0].width)
        assertEquals(4, result[0].height)
    }

    @Test
    fun boxNormalizerClampsToImageBounds() {
        val faces = listOf(FaceRect(6f, 6f, 12f, 12f))
        val result = AndroidFaceBoxNormalizer.normalizeAndPad(faces, 8, 8, 0.0)
        assertEquals(1, result.size)
        assertEquals(6, result[0].x)
        assertEquals(6, result[0].y)
        assertEquals(2, result[0].width)
        assertEquals(2, result[0].height)
    }

    @Test
    fun boxNormalizerRejectsFullyOutsideBox() {
        val faces = listOf(FaceRect(10f, 10f, 12f, 12f))
        val result = AndroidFaceBoxNormalizer.normalizeAndPad(faces, 8, 8, 0.0)
        assertTrue(result.isEmpty())
    }

    @Test
    fun boxNormalizerDedupicatesByIoU() {
        val faces = listOf(
            FaceRect(0f, 0f, 4f, 4f),
            FaceRect(1f, 0f, 5f, 4f),
        )
        val result = AndroidFaceBoxNormalizer.normalizeAndPad(faces, 8, 8, 0.0)
        assertEquals(1, result.size)
    }

    @Test
    fun boxNormalizerSortsDeterministically() {
        val faces = listOf(
            FaceRect(2f, 2f, 4f, 4f),
            FaceRect(0f, 0f, 2f, 2f),
        )
        val result = AndroidFaceBoxNormalizer.normalizeAndPad(faces, 8, 8, 0.0)
        assertEquals(2, result.size)
        assertEquals(0, result[0].x)
        assertEquals(0, result[0].y)
        assertEquals(2, result[1].x)
        assertEquals(2, result[1].y)
    }
}
