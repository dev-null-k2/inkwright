package app.inkwright.updates

import org.json.JSONException
import org.json.JSONObject

/**
 * `android-update.json`, the release asset that describes one release for the in-app updater
 * (written by scripts/release/android-update.mjs in release.yml; format in docs/UPDATES.md).
 *
 * Parsing is strict on purpose: anything unexpected means "no update offered", never a download
 * from somewhere else. The APK addresses must be this repository's release downloads over HTTPS,
 * the versionCode must be what the version string gives ([VersionCode]), and every APK needs a
 * size and a SHA-256. The checksum is what ties the file to the manifest; the signing check
 * before installing ([SignerCheck]) is what ties it to Inkwright's key.
 */
data class UpdateManifest(
    val version: String,
    val versionCode: Long,
    val channel: String,
    val published: String,
    val minSdk: Int,
    val notes: String,
    val apks: Map<String, Apk>,
) {
    data class Apk(val abi: String, val url: String, val size: Long, val sha256: String)

    /**
     * The APK for a device whose ABIs, best first, are [supportedAbis] (`Build.SUPPORTED_ABIS`):
     * its preferred ABI when the release has it, else the next one it can run (a 64-bit ARM phone
     * also runs armeabi-v7a), else null.
     */
    fun apkFor(supportedAbis: List<String>): Apk? = supportedAbis.firstNotNullOfOrNull { apks[it] }

    class Invalid(message: String) : Exception(message)

    companion object {
        const val SCHEMA = 1
        /** Release APKs are around 60 MB; anything far larger is not ours. */
        const val MAX_APK_BYTES = 512L * 1024 * 1024
        const val MAX_NOTES_CHARS = 20_000
        /** The manifest itself is a few kB. */
        const val MAX_MANIFEST_BYTES = 256 * 1024
        val ABIS = setOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
        private val SHA256 = Regex("^[0-9a-f]{64}$")

        /** Where every file of a release of [repo] ("owner/name") is downloaded from. */
        fun downloadPrefix(repo: String) = "https://github.com/$repo/releases/download/"

        /**
         * Reads and checks [json] for the app [packageName] published from [repo].
         * @throws Invalid with a reason meant for logs and bug reports.
         */
        fun parse(json: String, packageName: String, repo: String): UpdateManifest {
            val o = try { JSONObject(json) } catch (e: JSONException) { throw Invalid("not JSON: ${e.message}") }
            fun str(key: String) = o.optString(key, "").takeIf { o.has(key) && it.isNotEmpty() } ?: throw Invalid("missing $key")
            if (o.optInt("schema", -1) != SCHEMA) throw Invalid("unsupported schema ${o.opt("schema")}")
            if (str("app") != packageName) throw Invalid("for another app (${o.optString("app")})")
            val version = str("version")
            val expected = VersionCode.of(version) ?: throw Invalid("version $version is not in the versioning scheme")
            val code = o.optLong("versionCode", -1)
            if (code != expected) throw Invalid("versionCode $code does not match version $version ($expected)")
            val channel = str("channel")
            val prerelease = VersionCode.parse(version)!!.isPrerelease
            if (channel != (if (prerelease) "beta" else "stable")) throw Invalid("channel $channel does not match version $version")
            val notes = o.optString("notes", "")
            if (notes.length > MAX_NOTES_CHARS) throw Invalid("notes are too long")
            val prefix = downloadPrefix(repo)
            val list = o.optJSONObject("apks") ?: throw Invalid("missing apks")
            val apks = buildMap {
                for (abi in list.keys()) {
                    if (abi !in ABIS) throw Invalid("unknown ABI $abi")
                    val a = list.optJSONObject(abi) ?: throw Invalid("apks.$abi is not an object")
                    val url = a.optString("url", "")
                    // Plain prefix check plus no tricks after it: no "..", queries or fragments.
                    if (!url.startsWith(prefix) || url.contains("..") || url.contains('?') || url.contains('#') || !url.endsWith(".apk")) {
                        throw Invalid("apks.$abi.url is not a release download of $repo")
                    }
                    val size = a.optLong("size", -1)
                    if (size <= 0 || size > MAX_APK_BYTES) throw Invalid("apks.$abi.size $size is out of range")
                    val sha = a.optString("sha256", "").lowercase()
                    if (!SHA256.matches(sha)) throw Invalid("apks.$abi.sha256 is not a SHA-256")
                    put(abi, Apk(abi, url, size, sha))
                }
            }
            if (apks.isEmpty()) throw Invalid("no APKs")
            return UpdateManifest(
                version = version,
                versionCode = code,
                channel = channel,
                published = o.optString("published", ""),
                minSdk = o.optInt("minSdk", 1),
                notes = notes,
                apks = apks,
            )
        }

        /** True when [url] may be fetched as the manifest of a release of [repo]. */
        fun isManifestUrl(url: String, repo: String): Boolean =
            url.startsWith(downloadPrefix(repo)) && url.endsWith("/android-update.json") && !url.contains("..") && !url.contains('?')
    }
}
