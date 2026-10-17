package expo.modules.kscanlivevtonative

import java.security.MessageDigest

object LiveVtoModelIntegrity {
  // config/on-device-model-authority.json; identical on Android and iOS.
  const val APPROVED_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
  fun isApproved(bytes: ByteArray): Boolean =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } == APPROVED_SHA256
}
