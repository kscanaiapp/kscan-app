package expo.modules.kscanlivevtonative
import java.security.MessageDigest

/** Pinned at catalog acceptance, not computed from a caller-supplied manifest. */
object LiveVtoBundledAssetIntegrity {
  private val ids = mapOf("n1b-fixture" to "081350cef7f5c83e05c3e6c1", "n1c-asym-fixture" to "n1c-asym-marker-fixture", "ascolour-5001-black-v1" to "524ab66a3f16bda5c3d7f9fe")
  private val hashes = mapOf(
    "n1b-fixture/manifest.json" to "32f311c39566b448b1a37c4f9e9286437f245ffdad25b4876e4d3a1ae21bce2d",
    "n1b-fixture/texture.png" to "5deca90a677b8ab31f01108b865641eccafb2f3f8f3c21083944acc9adec4393",
    "n1b-fixture/alpha.png" to "709dda03727503c3cccfd9ad8193b35cc576703a01cf4661f9215aa2ce312c00",
    "n1c-asym-fixture/manifest.json" to "3d8aafb41bcbfb444312a95741ef41c1c5a59577ab118a96171982f7e7ac1347",
    "n1c-asym-fixture/texture.png" to "9c0e24fd94f10477c80677061ad7c49fbcd2237959dd0e30565fc840cbdb67f8",
    "n1c-asym-fixture/alpha.png" to "709dda03727503c3cccfd9ad8193b35cc576703a01cf4661f9215aa2ce312c00",
    "ascolour-5001-black-v1/manifest.json" to "da3fa1a0613f0923d26acbde8aca401759fc6909521ea97083acb005310cdf79",
    "ascolour-5001-black-v1/texture.png" to "c5ff5abfa5898fabe4ec1ae1d8a43cebad282ad570ae966d81fcbdddf983afe6",
    "ascolour-5001-black-v1/alpha.png" to "2c189b257d48fdbbe7614fb381fb755f6320d73af168da25954726101c6ca7ba"
  )
  fun identityMatches(key: String, id: String): Boolean = ids[key] == id
  fun validate(key: String, file: String, bytes: ByteArray): Boolean {
    val expected = hashes["$key/$file"] ?: return false
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return digest == expected
  }
}
