package app.inkwright.updates

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import app.inkwright.BuildConfig
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The in-app updater's native half (GitHub builds only; docs/UPDATES.md). JS interface:
 * apps/web/src/updates/plugin.ts. The web layer finds releases through the GitHub API and decides
 * when to update; this plugin does what needs the platform:
 *
 *  - info()                     → { abis, sdk, repo, distribution, canInstall, installerOfRecord, installer }
 *  - fetchManifest({ url })     → { manifest, apk }: the release's android-update.json, checked
 *                                 ([UpdateManifest]), and the APK for this phone's ABI (or null)
 *  - download({ url })          → { path } after the APK of that manifest has downloaded, matched
 *                                 its SHA-256 and passed [ApkVerifier] (package, version, signer);
 *                                 events 'progress' { phase: download|verify, loaded, total }
 *  - cancel()                   → stops a download (the part file is kept for a retry)
 *  - install({ path })          → { status: 'started' | 'needs-permission' }; then events
 *                                 'install' { status: pending-user-action|success|failure, reason }
 *  - openInstallSettings()      → Android's "Install unknown apps" page for Inkwright; when the
 *                                 person comes back, event 'installPermission' { granted }
 *  - cleanup()                  → { removed }: deletes downloaded updates (also done on every launch
 *                                 for versions not newer than the running one)
 *
 * Errors reject with a code (`call.reject(message, code)`) that the web layer turns into plain
 * language: network, gone, http, forbidden, server, changed, bad-response, invalid, storage,
 * checksum, not-inkwright, version, not-newer, signature, cancelled, busy.
 */
@CapacitorPlugin(name = "InkwrightUpdater")
class UpdaterPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var dir: File
    private lateinit var downloader: ApkDownloader
    private lateinit var verifier: ApkVerifier
    private lateinit var installer: SelfInstaller

    /** The last manifest fetched: download() only accepts an APK URL it listed. */
    @Volatile private var manifest: UpdateManifest? = null
    @Volatile private var job: Job? = null
    private var awaitingPermission = false

    override fun load() {
        val app = context.applicationContext
        dir = File(app.cacheDir, UpdateFiles.DIR)
        verifier = ApkVerifier(app)
        downloader = ApkDownloader(dir, "Inkwright-Android/${runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"}")
        installer = SelfInstaller(app) { event, confirm -> onInstallStatus(event, confirm) }
        scope.launch(Dispatchers.IO) { removeFiles { UpdateFiles.isStale(it, verifier.installedVersionCode()) } }
    }

    override fun handleOnResume() {
        super.handleOnResume()
        if (awaitingPermission) {
            awaitingPermission = false
            notifyListeners(EVENT_PERMISSION, JSObject().put("granted", installer.canInstall()))
        }
    }

    override fun handleOnDestroy() {
        installer.close()
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun info(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("abis", JSArray().apply { Build.SUPPORTED_ABIS.forEach { put(it) } })
                .put("sdk", Build.VERSION.SDK_INT)
                .put("repo", BuildConfig.UPDATE_REPO)
                .put("distribution", BuildConfig.DISTRIBUTION)
                .put("canInstall", installer.canInstall())
                .put("installerOfRecord", installer.isInstallerOfRecord())
                .put("installer", installer.installerPackage()),
        )
    }

    @PluginMethod
    fun fetchManifest(call: PluginCall) {
        val url = call.getString("url").orEmpty()
        if (!UpdateManifest.isManifestUrl(url, BuildConfig.UPDATE_REPO)) return call.reject("Not a release manifest of ${BuildConfig.UPDATE_REPO}.", "invalid")
        scope.launch {
            try {
                val text = downloader.fetchText(url, UpdateManifest.MAX_MANIFEST_BYTES)
                val m = try {
                    UpdateManifest.parse(text, context.packageName, BuildConfig.UPDATE_REPO)
                } catch (e: UpdateManifest.Invalid) {
                    throw UpdateException("invalid", "The release’s update description is not valid: ${e.message}")
                }
                manifest = m
                val apk = if (Build.VERSION.SDK_INT >= m.minSdk) m.apkFor(Build.SUPPORTED_ABIS.toList()) else null
                call.resolve(JSObject().put("manifest", m.toJs()).put("apk", apk?.toJs() ?: JSObject.NULL))
            } catch (e: UpdateException) {
                call.reject(e.message, e.code)
            } catch (e: Exception) {
                Log.w(TAG, "Manifest fetch failed", e)
                call.reject("Couldn’t read the update description.", "network")
            }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val m = manifest ?: return call.reject("Check for updates first.", "invalid")
        val apk = m.apks.values.firstOrNull { it.url == call.getString("url") } ?: return call.reject("That file is not in the release’s update description.", "invalid")
        if (job?.isActive == true) return call.reject("An update is already downloading.", "busy")
        job = scope.launch {
            try {
                val file = downloader.download(apk, UpdateFiles.verified(m.versionCode, apk.abi)) { phase, loaded, total ->
                    notifyListeners(EVENT_PROGRESS, JSObject().put("phase", phase).put("loaded", loaded).put("total", total))
                }
                notifyListeners(EVENT_PROGRESS, JSObject().put("phase", "verify").put("loaded", apk.size).put("total", apk.size))
                try {
                    verifier.verify(file, m.versionCode)
                } catch (e: UpdateException) {
                    file.delete()
                    throw e
                }
                call.resolve(JSObject().put("path", file.path))
            } catch (e: CancellationException) {
                call.reject("The download was cancelled.", "cancelled")
            } catch (e: UpdateException) {
                call.reject(e.message, e.code)
            } catch (e: Exception) {
                Log.w(TAG, "Update download failed", e)
                call.reject("The download failed.", "network")
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        job?.cancel()
        call.resolve()
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val path = call.getString("path").orEmpty()
        val file = File(path)
        // Only a file this plugin verified, in its own folder.
        if (file.parentFile?.canonicalPath != dir.canonicalPath || !file.isFile || file.name.endsWith(".part")) return call.reject("No verified update to install.", "invalid")
        if (!installer.canInstall()) return call.resolve(JSObject().put("status", "needs-permission"))
        scope.launch(Dispatchers.IO) {
            try {
                // Checked again: the file sat in the cache since it was downloaded.
                verifier.verify(file, UpdateFiles.versionCodeOf(file.name) ?: throw UpdateException("invalid", "Unexpected update file."))
                installer.install(file)
                call.resolve(JSObject().put("status", "started"))
            } catch (e: UpdateException) {
                call.reject(e.message, e.code)
            } catch (e: Exception) {
                Log.w(TAG, "Install failed to start", e)
                call.reject("Android couldn’t start the installation.", "install")
            }
        }
    }

    @PluginMethod
    fun openInstallSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        try {
            awaitingPermission = true
            (activity ?: context).startActivity(intent.apply { if (activity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
            call.resolve()
        } catch (e: Exception) {
            awaitingPermission = false
            call.reject("Couldn’t open Android’s settings.", "settings")
        }
    }

    @PluginMethod
    fun cleanup(call: PluginCall) {
        scope.launch(Dispatchers.IO) {
            call.resolve(JSObject().put("removed", removeFiles { true }))
        }
    }

    private fun onInstallStatus(event: InstallOutcome.Event, confirm: Intent?) {
        if (event.status == InstallOutcome.PENDING_USER_ACTION && confirm != null) {
            scope.launch(Dispatchers.Main) {
                try {
                    (activity ?: return@launch).startActivity(confirm)
                } catch (e: Exception) {
                    Log.w(TAG, "Couldn’t show Android's install confirmation", e)
                    notifyListeners(EVENT_INSTALL, JSObject().put("status", InstallOutcome.FAILURE).put("reason", "blocked"))
                    return@launch
                }
                notifyListeners(EVENT_INSTALL, JSObject().put("status", event.status))
            }
            return
        }
        if (event.status == InstallOutcome.SUCCESS) scope.launch(Dispatchers.IO) { removeFiles { true } }
        notifyListeners(EVENT_INSTALL, JSObject().put("status", event.status).put("reason", event.reason ?: JSObject.NULL))
    }

    private suspend fun removeFiles(which: (String) -> Boolean): Int = withContext(Dispatchers.IO) {
        if (job?.isActive == true) return@withContext 0
        dir.listFiles().orEmpty().count { f -> which(f.name) && f.delete() }
    }

    private fun UpdateManifest.toJs() = JSObject()
        .put("version", version)
        .put("versionCode", versionCode)
        .put("channel", channel)
        .put("published", published)
        .put("minSdk", minSdk)
        .put("notes", notes)

    private fun UpdateManifest.Apk.toJs() = JSObject().put("abi", abi).put("url", url).put("size", size).put("sha256", sha256)

    companion object {
        const val TAG = "InkwrightUpdater"
        const val EVENT_PROGRESS = "progress"
        const val EVENT_INSTALL = "install"
        const val EVENT_PERMISSION = "installPermission"
    }
}
