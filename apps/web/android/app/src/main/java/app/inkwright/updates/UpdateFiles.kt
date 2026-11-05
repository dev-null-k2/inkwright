package app.inkwright.updates

/**
 * Names of downloaded updates in the app's cache (`cache/updates/`), and which of them can go.
 *
 * A download is `Inkwright-<versionCode>-<abi>.apk.part` while it arrives and
 * `Inkwright-<versionCode>-<abi>.apk` once its checksum and signer were verified. Every launch
 * deletes files for versions that are not newer than the running app (the update was installed,
 * or a newer one replaced it) and anything else that doesn't belong; a verified newer APK is kept
 * so "Install" after a restart needs no second download.
 */
object UpdateFiles {
    const val DIR = "updates"
    private val NAME = Regex("""^Inkwright-(\d{1,10})-([a-z0-9_-]+)\.apk(\.part)?$""")

    fun verified(versionCode: Long, abi: String) = "Inkwright-$versionCode-$abi.apk"
    fun partial(versionCode: Long, abi: String) = verified(versionCode, abi) + ".part"

    /** The versionCode in a download's file name, or null for any other name. */
    fun versionCodeOf(name: String): Long? = NAME.matchEntire(name)?.groupValues?.get(1)?.toLongOrNull()

    /** Whether the file [name] in the updates folder should be deleted when the app runs [installedCode]. */
    fun isStale(name: String, installedCode: Long): Boolean {
        val code = versionCodeOf(name) ?: return true
        return code <= installedCode
    }
}
