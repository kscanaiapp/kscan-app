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
        // Resolve symlinks and standardize (collapsing "." and ".." segments)
        // on BOTH the candidate path and the cache directory before
        // comparing. A bare hasPrefix on unresolved paths would incorrectly
        // accept a sibling directory such as "kscan-pii-native-evil/" (same
        // string prefix, different directory) and would not reliably reject
        // ".." traversal.
        let resolvedPath = url.resolvingSymlinksInPath().standardizedFileURL.path
        let cacheDir = cacheDirectory().resolvingSymlinksInPath().standardizedFileURL.path
        return resolvedPath == cacheDir || resolvedPath.hasPrefix(cacheDir + "/")
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
