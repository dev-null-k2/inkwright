package app.inkwright.webview

import android.app.Activity
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import com.getcapacitor.WebViewListener

/**
 * Decides whether a lost WebView renderer is recovered (by recreating the activity) or left to crash
 * the app. Recovering is right for the occasional loss — Android killing the renderer to reclaim
 * memory, or a one-off renderer crash — but a renderer that dies again and again (for example on
 * every page load) would otherwise put the app in a restart loop, so after [maxRecoveries] within
 * [windowMs] the loss is no longer handled and the crash is reported as usual.
 *
 * Pure (time is passed in) so it is unit-tested on the JVM.
 */
class RendererRecoveryPolicy(private val maxRecoveries: Int = 3, private val windowMs: Long = 60_000) {
    private val recent = ArrayDeque<Long>()

    /** A renderer was lost at [nowMs]: true to recover, false to let the app crash. */
    fun shouldRecover(nowMs: Long): Boolean {
        while (recent.isNotEmpty() && nowMs - recent.first() >= windowMs) recent.removeFirst()
        if (recent.size >= maxRecoveries) return false
        recent.addLast(nowMs)
        return true
    }
}

/**
 * Handles WebView renderer loss for Capacitor's bridge (Bridge.addWebViewListener).
 *
 * Without a handler, Android's WebView kills the whole app when its renderer process goes away
 * ("Render process's crash wasn't handled by all associated webviews"). That also happens when the
 * system kills only the renderer to free memory while Inkwright is in the background, so the user
 * would come back to a crashed app. Notes are autosaved within about a second of each change, so
 * recreating the activity (a fresh WebView that reopens the library) loses at most the last stroke.
 * Found with the Android emulator suite (docs/TESTING.md), where a renderer crash took the app down.
 */
class RendererRecovery(
    private val activity: Activity,
    // Process-wide by default: each recovery recreates the activity (and this listener), and the
    // loop guard must remember the earlier losses.
    private val policy: RendererRecoveryPolicy = processPolicy,
) : WebViewListener() {
    override fun onRenderProcessGone(webView: WebView, detail: RenderProcessGoneDetail?): Boolean {
        val crashed = Build.VERSION.SDK_INT >= 26 && detail?.didCrash() == true
        if (!policy.shouldRecover(SystemClock.elapsedRealtime())) {
            Log.e(TAG, "WebView renderer lost again (crashed=$crashed); not recovering")
            return false
        }
        Log.w(TAG, "WebView renderer lost (crashed=$crashed); recreating the activity")
        // The old WebView must not be used again; recreate() builds a new bridge and WebView.
        activity.runOnUiThread { if (!activity.isFinishing && !activity.isDestroyed) activity.recreate() }
        return true
    }

    private companion object {
        const val TAG = "Inkwright"
        val processPolicy = RendererRecoveryPolicy()
    }
}
