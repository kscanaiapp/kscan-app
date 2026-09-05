package expo.modules.kscanlivevtonative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * N1-A: scaffold + registration only.
 *
 * Registers as "KScanLiveVto" -- this exact string is
 * constants/featureFlags.ts's LIVE_VTO_NATIVE_MODULE_NAME, the value
 * services/vto/liveVtoNativeModule.ts's requireOptionalNativeModule() looks
 * up. Do not rename either side independently.
 *
 * getCapability() is synchronous (Function, not AsyncFunction) because the
 * merged application adapter calls it without awaiting
 * (describeLiveVtoNativeCapability in liveVtoNativeModule.ts) -- an
 * AsyncFunction here would hand JS a Promise where a plain object is
 * expected and silently fail every capability check.
 *
 * Field names are `capable`/`runtimeReady`/`runtimeVersion` -- the actual
 * merged LiveVtoNativeSelfCheck shape in services/vto/liveVtoNativeModule.ts,
 * not the informal "moduleAvailable" example the build mission used. Both
 * are false at N1-A: this stage proves registration only, and neither device
 * eligibility nor runtime initialization has been implemented yet. Claiming
 * `capable: true` here would be exactly the "registration is not capability"
 * mistake the application module's own header comment warns against.
 *
 * No Events() yet, no commands yet -- those are declared gate by gate
 * (N1-B..N1-G) as their real implementations land, not speculatively here.
 */
class KScanLiveVtoNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KScanLiveVto")

    Function("getCapability") {
      mapOf(
        "capable" to false,
        "runtimeReady" to false,
        "runtimeVersion" to RUNTIME_VERSION
      )
    }
  }

  companion object {
    private const val RUNTIME_VERSION = "n1-a"
  }
}
