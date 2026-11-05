package app.inkwright.updates

import java.security.MessageDigest

/**
 * Whether a downloaded APK is signed by the same key as the running app — checked before the
 * updater hands it to Android (docs/UPDATES.md, "Security").
 *
 * Android enforces this too (it refuses an update signed by another key), so the check is not the
 * last line of defence. It is there so a wrong file is refused with a clear message before anything
 * is installed, and it does not depend on what a particular Android version's installer reports.
 *
 * Certificates are compared by SHA-256 of their DER encoding (`Signature.toByteArray()`), the
 * same fingerprint `apksigner verify --print-certs` prints.
 */
object SignerCheck {
    /**
     * A package's signers: [current] are the certificates it is signed with now (one, unless the
     * APK has several signers); [history] is its proof-of-rotation lineage, oldest first, ending
     * with the current one (APK Signature Scheme v3; just the current certificate without rotation).
     */
    data class Signers(val current: Set<String>, val history: List<String> = current.toList())

    fun digest(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /**
     * True when [update] may replace [installed]: the same signers, or — with one signer on each
     * side — an update whose rotation lineage contains the installed certificate (a key rotated
     * with v3 rotation, which Android accepts too). Nothing is accepted when either side has no
     * certificates (an unsigned or unreadable APK).
     */
    fun accepts(installed: Signers, update: Signers): Boolean {
        if (installed.current.isEmpty() || update.current.isEmpty()) return false
        if (installed.current == update.current) return true
        return installed.current.size == 1 && update.current.size == 1 && installed.current.first() in update.history
    }
}
