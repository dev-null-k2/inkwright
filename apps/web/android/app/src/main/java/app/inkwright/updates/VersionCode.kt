package app.inkwright.updates

/**
 * Android versionCodes from release versions (docs/UPDATES.md, "Version codes").
 *
 * Android installs an update only when its versionCode is higher, so every release, pre-releases
 * included, needs a higher code than the one before, and a final release must sort above its own
 * betas:
 *
 * ```
 * MAJOR.MINOR.PATCH[-alpha|beta|rc[.N]]
 * versionCode = (MAJOR·10 000 + MINOR·100 + PATCH) · 1000 + stage + N
 * stage: alpha 100, beta 200, rc 300, final release 900;  N = 0…99 (absent = 0)
 * ```
 *
 * 0.9.0-beta.6 → 900206, 0.9.0-rc.1 → 900301, 0.9.0 → 900900, 0.9.1-beta.1 → 901201,
 * 1.0.0 → 10000900. MINOR and PATCH go to 99 and MAJOR to 209 (2 099 999 900 is just under
 * Google Play's limit of 2 100 000 000).
 *
 * The same scheme is implemented in scripts/release/version-code.mjs (which release.yml uses to
 * stamp the build) and apps/web/src/updates/versionCode.ts (which picks the newest release); all
 * three are tested against the same table, src/test/resources/version-codes.json.
 */
object VersionCode {
    const val MAX = 2_100_000_000L

    private val PATTERN = Regex("""^v?(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:-(alpha|beta|rc)(?:\.(\d{1,2}))?)?$""")
    private val STAGES = mapOf("alpha" to 100, "beta" to 200, "rc" to 300)
    private const val FINAL = 900

    data class Parsed(val major: Int, val minor: Int, val patch: Int, val stage: String?, val number: Int) {
        val isPrerelease get() = stage != null
    }

    /** The parts of [version] ("0.9.0-beta.6", a leading "v" allowed), or null if it isn't in the scheme. */
    fun parse(version: String): Parsed? {
        val m = PATTERN.matchEntire(version.trim()) ?: return null
        val (major, minor, patch, stage, n) = m.destructured
        val parsed = Parsed(major.toInt(), minor.toInt(), patch.toInt(), stage.ifEmpty { null }, n.toIntOrNull() ?: 0)
        return if (parsed.major > 209) null else parsed
    }

    /** The versionCode of [version], or null if it isn't in the scheme. */
    fun of(version: String): Long? {
        val p = parse(version) ?: return null
        val base = p.major * 10_000L + p.minor * 100L + p.patch
        val suffix = (p.stage?.let { STAGES.getValue(it) } ?: FINAL) + p.number
        return base * 1000 + suffix
    }
}
