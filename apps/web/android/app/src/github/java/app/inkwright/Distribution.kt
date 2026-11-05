package app.inkwright

import app.inkwright.updates.UpdaterPlugin
import com.getcapacitor.Plugin

/**
 * What GitHub-distributed builds add (-Pinkwright.distribution=github, the default; see
 * app/build.gradle). Google Play builds compile src/play/…/Distribution.kt instead.
 */
object Distribution {
    /** Capacitor plugins [MainActivity] registers: the in-app updater (docs/UPDATES.md). */
    val plugins: List<Class<out Plugin>> = listOf(UpdaterPlugin::class.java)
}
