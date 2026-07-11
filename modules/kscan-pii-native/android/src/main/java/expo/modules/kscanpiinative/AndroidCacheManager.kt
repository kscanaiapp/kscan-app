package expo.modules.kscanpiinative

import android.content.Context
import java.io.File
import java.util.UUID

object AndroidCacheManager {
    fun getCacheDirectory(context: Context): File {
        return File(context.cacheDir, NativePrivacyConstants.CACHE_NAMESPACE).apply {
            if (!exists()) mkdirs()
        }
    }

    fun createOutputFile(context: Context): File {
        val dir = getCacheDirectory(context)
        return File(dir, "${NativePrivacyConstants.OUTPUT_FILE_PREFIX}${UUID.randomUUID()}.${NativePrivacyConstants.OUTPUT_EXTENSION}")
    }

    fun isOwnedCacheUri(context: Context, uriString: String): Boolean {
        if (!uriString.startsWith("file://")) return false
        val path = uriString.removePrefix("file://")
        val cacheDir = getCacheDirectory(context).absolutePath
        val canonicalPath = try {
            File(path).canonicalPath
        } catch (e: Exception) {
            return false
        }
        // A bare prefix comparison would incorrectly accept a sibling
        // directory such as "kscan-pii-native-evil/" as owned, since that
        // string also starts with cacheDir. Require an exact match or a
        // path separator immediately after the prefix.
        return canonicalPath == cacheDir || canonicalPath.startsWith(cacheDir + File.separator)
    }

    fun cleanupUri(context: Context, uriString: String): NativeCleanupResult {
        if (!isOwnedCacheUri(context, uriString)) {
            return NativeCleanupResult(
                deleted = false,
                rejected = true,
                warnings = listOf("URI is not inside the module-owned cache namespace: $uriString"),
            )
        }

        val file = File(uriString.removePrefix("file://"))
        if (!file.exists()) {
            return NativeCleanupResult(
                deleted = true,
                rejected = false,
                warnings = listOf("File already absent: $uriString"),
            )
        }

        return try {
            val deleted = file.delete()
            if (deleted) {
                NativeCleanupResult(
                    deleted = true,
                    rejected = false,
                    warnings = emptyList(),
                )
            } else {
                NativeCleanupResult(
                    deleted = false,
                    rejected = false,
                    warnings = listOf("Delete returned false for $uriString"),
                )
            }
        } catch (e: Exception) {
            NativeCleanupResult(
                deleted = false,
                rejected = false,
                warnings = listOf("Delete failed: ${e.message}"),
            )
        }
    }

    fun deleteUnverifiableOutput(outputFile: File) {
        try {
            if (outputFile.exists()) outputFile.delete()
        } catch (e: Exception) {
            // Best-effort cleanup; do not leak exceptions.
        }
    }
}
