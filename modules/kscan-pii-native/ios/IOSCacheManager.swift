import Foundation

struct IOSCacheManager {
    static func cacheDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches.appendingPathComponent(NativePrivacyConstants.cacheNamespace, isDirectory: true)
    }

    static func createOutputFile() -> URL {
        let dir = cacheDirectory()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
        return dir.appendingPathComponent("\(NativePrivacyConstants.outputFilePrefix)\(UUID().uuidString).\(NativePrivacyConstants.outputExtension)")
    }

    static func isOwnedCacheUri(_ uriString: String) -> Bool {
        guard let url = URL(string: uriString), url.scheme == "file" else {
            return false
        }
        let path = url.path
        let cacheDir = cacheDirectory().path
        let resolvedPath = (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? path
        return resolvedPath.hasPrefix(cacheDir)
    }

    static func cleanupUri(_ uriString: String) -> NativeCleanupResult {
        guard isOwnedCacheUri(uriString) else {
            return NativeCleanupResult(
                deleted: false,
                rejected: true,
                warnings: ["URI is not inside the module-owned cache namespace: \(uriString)"]
            )
        }

        let path = URL(string: uriString)?.path ?? uriString
        let fileURL = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return NativeCleanupResult(deleted: true, rejected: false, warnings: ["File already absent: \(uriString)"])
        }

        do {
            try FileManager.default.removeItem(at: fileURL)
            return NativeCleanupResult(deleted: true, rejected: false, warnings: [])
        } catch {
            return NativeCleanupResult(deleted: false, rejected: false, warnings: ["Delete failed: \(error.localizedDescription)"])
        }
    }

    static func deleteUnverifiableOutput(_ outputFile: URL) {
        try? FileManager.default.removeItem(at: outputFile)
    }
}
