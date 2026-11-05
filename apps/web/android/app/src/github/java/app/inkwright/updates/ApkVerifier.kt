package app.inkwright.updates

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import java.io.File

/**
 * Checks a downloaded APK (already matching the manifest's SHA-256) before it is installed: it is
 * Inkwright (same package name), it is the version the manifest promised and newer than the
 * running app, and it is signed by the running app's key ([SignerCheck]). Android checks the
 * signature again when it installs; this makes a wrong file fail early and plainly.
 */
class ApkVerifier(private val context: Context) {
    private val pm get() = context.packageManager

    fun installedVersionCode(): Long = versionCodeOf(pm.getPackageInfo(context.packageName, 0))

    fun installedSigners(): SignerCheck.Signers = signersOf(
        if (Build.VERSION.SDK_INT >= 28) pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        else @Suppress("DEPRECATION") pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES),
    )

    /** @throws UpdateException when [apk] must not be installed. */
    fun verify(apk: File, expectedVersionCode: Long) {
        val info = (
            if (Build.VERSION.SDK_INT >= 28) pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
            else @Suppress("DEPRECATION") pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNATURES)
        ) ?: throw UpdateException("invalid", "The downloaded file is not an Android app.")
        if (info.packageName != context.packageName) throw UpdateException("not-inkwright", "The downloaded app is ${info.packageName}, not Inkwright.")
        val code = versionCodeOf(info)
        if (code != expectedVersionCode) throw UpdateException("version", "The downloaded app is version $code, not $expectedVersionCode.")
        if (code <= installedVersionCode()) throw UpdateException("not-newer", "The downloaded app is not newer than this one.")
        if (!SignerCheck.accepts(installedSigners(), signersOf(info))) {
            throw UpdateException("signature", "The downloaded app is not signed with Inkwright’s key.")
        }
    }

    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()

    private fun signersOf(info: PackageInfo): SignerCheck.Signers {
        fun digests(sigs: Array<Signature>?) = sigs.orEmpty().map { SignerCheck.digest(it.toByteArray()) }
        if (Build.VERSION.SDK_INT >= 28) {
            val s = info.signingInfo ?: return SignerCheck.Signers(emptySet(), emptyList())
            return if (s.hasMultipleSigners()) {
                SignerCheck.Signers(digests(s.apkContentsSigners).toSet(), emptyList())
            } else {
                // Lineage oldest first; the last entry is the certificate the APK is signed with now.
                val history = digests(s.signingCertificateHistory)
                SignerCheck.Signers(setOfNotNull(history.lastOrNull()), history)
            }
        }
        @Suppress("DEPRECATION")
        val current = digests(info.signatures)
        return SignerCheck.Signers(current.toSet(), current)
    }
}
