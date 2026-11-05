package app.inkwright

import com.getcapacitor.Plugin

/**
 * Google Play builds (-Pinkwright.distribution=play; see app/build.gradle): Play delivers updates,
 * so there is no in-app updater, and without its plugin the web layer's Updates module is not
 * registered either (apps/web/src/updates/modules.ts).
 */
object Distribution {
    val plugins: List<Class<out Plugin>> = emptyList()
}
