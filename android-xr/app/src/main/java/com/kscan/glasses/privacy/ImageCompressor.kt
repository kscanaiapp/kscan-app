package com.kscan.glasses.privacy

/**
 * Compresses sanitized images before upload.
 * TODO: Wire Android BitmapFactory / JPEG quality tuning.
 */
class ImageCompressor {
    fun compressJpeg(base64: String, quality: Int = 85): String {
        // Alpha: pass-through; real implementation re-encodes after face mask
        return base64
    }
}
