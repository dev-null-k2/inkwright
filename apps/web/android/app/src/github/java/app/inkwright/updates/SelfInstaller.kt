package app.inkwright.updates

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import java.io.File

/**
 * Installs a verified APK of Inkwright over itself through a [PackageInstaller] session.
 *
 * On Android 12+ the session asks for [PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED]:
 * Android then updates without a confirmation screen when Inkwright is the app's installer of
 * record — true from the first update Inkwright installed itself on (the very first install from a
 * browser or file manager has that app as installer, so the first update still asks once). When
 * Android wants confirmation anyway, the session reports [PackageInstaller.STATUS_PENDING_USER_ACTION]
 * with Android's own confirmation screen, which [onStatus] receives to show.
 *
 * Results arrive as a broadcast to a receiver registered here (not exported; the PendingIntent
 * names this package explicitly). A successful update replaces the running app, so its success
 * event usually never arrives: the process is stopped and the person opens the new version.
 */
class SelfInstaller(private val context: Context, private val onStatus: (InstallOutcome.Event, Intent?) -> Unit) {
    private val action = "${context.packageName}.UPDATE_INSTALL_STATUS"

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            val confirm = if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) else null
            onStatus(InstallOutcome.of(status), confirm)
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    /** Whether Android lets Inkwright install apps ("Install unknown apps" in Android's settings). */
    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    /** Whether Inkwright installed the running copy itself, so updates need no confirmation (Android 12+). */
    fun isInstallerOfRecord(): Boolean = installerPackage() == context.packageName

    fun installerPackage(): String? = try {
        if (Build.VERSION.SDK_INT >= 30) context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        else @Suppress("DEPRECATION") context.packageManager.getInstallerPackageName(context.packageName)
    } catch (_: PackageManager.NameNotFoundException) {
        null
    }

    /** Writes [apk] into a new session and commits it; the outcome comes to [onStatus]. Blocking I/O. */
    fun install(apk: File) {
        val installer = context.packageManager.packageInstaller
        // A session left over from an earlier attempt (the app was closed mid-install) is dropped.
        for (s in installer.mySessions) runCatching { installer.abandonSession(s.sessionId) }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 256 * 1024) }
                    session.fsync(out)
                }
                // Mutable so the installer can add its status extras; explicit (this package) as
                // Android 14 requires of mutable PendingIntents.
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val sender = PendingIntent.getBroadcast(context, id, Intent(action).setPackage(context.packageName), flags)
                session.commit(sender.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(id) }
            throw e
        }
    }

    fun close() {
        runCatching { context.unregisterReceiver(receiver) }
    }
}
