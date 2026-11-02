package app.inkstone

import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.core.content.ContextCompat
import app.inkstone.display.DisplayModeInfo
import app.inkstone.display.RefreshRatePicker
import app.inkstone.feel.NativePaperFeel
import app.inkstone.ink.NativeInkTip
import app.inkstone.input.StylusButtonEvent
import app.inkstone.input.StylusKeyFilter
import com.getcapacitor.BridgeActivity
import ee.forgr.capacitor.social.login.GoogleProvider
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin
import ee.forgr.capacitor.social.login.SocialLoginPlugin

/**
 * The Capacitor host activity, plus what the WebView cannot do on its own:
 *  - forwards stylus button key events to the web layer (InkstoneNative 'stylusButton');
 *  - asks for the display's highest refresh rate while Inkstone is in front;
 *  - requests unbuffered pointer dispatch so pen samples reach the WebView as they arrive;
 *  - shows every touch/stylus MotionEvent to the instant ink tip (the newest few ms of a pen stroke
 *    drawn on a front-buffered overlay above the WebView, InkstoneNative.inkTipBegin) and to the
 *    native paper-feel engine (writing sound and haptic grain, InkstoneNative.feelBegin) before the
 *    WebView gets it — read-only, never consumed;
 *  - routes Google authorization results to @capgo/capacitor-social-login (needed for the
 *    Drive scopes the web layer requests).
 */
class MainActivity : BridgeActivity(), ModifiedMainActivityForSocialLoginPlugin {
    private val stylusKeys = StylusKeyFilter()
    private var paperFeel: NativePaperFeel? = null
    private var inkTip: NativeInkTip? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(InkstoneNativePlugin::class.java)
        super.onCreate(savedInstanceState)
        bridge?.webView?.let { webView ->
            // Paper colour (light/dark) behind the page so loads and fold/unfold never flash white.
            webView.setBackgroundColor(ContextCompat.getColor(this, R.color.inkstone_splash))
            if (UNBUFFERED_POINTER_DISPATCH && Build.VERSION.SDK_INT >= 30) {
                // By default Android batches MOVE events and hands them over once per frame.
                // Unbuffered dispatch delivers stylus/touch samples to the WebView as they arrive
                // (Chromium still coalesces them per frame for pointermove, but they get there
                // sooner and pointerrawupdate listeners see every one). Posted so it applies once
                // the view is attached to the window.
                webView.post { webView.requestUnbufferedDispatch(InputDevice.SOURCE_CLASS_POINTER) }
            }
        }
        preferHighestRefreshRate()
    }

    override fun onResume() {
        super.onResume()
        preferHighestRefreshRate()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Folding/unfolding can move the window to a panel with different modes.
        preferHighestRefreshRate()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val decision = stylusKeys.onKey(event.action, event.keyCode, event.repeatCount)
        if (!decision.consume) return super.dispatchKeyEvent(event)
        decision.event?.let(::emitStylus)
        return true
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        // Before super, so the ink tip and the feel engine see each sample as early as the WebView
        // does. The tip goes first: it is the one racing the display.
        (inkTip ?: findInkTip())?.onTouchEvent(ev)
        (paperFeel ?: findPaperFeel())?.onTouchEvent(ev, resources.displayMetrics)
        return super.dispatchTouchEvent(ev)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // A release that happens while another window has focus never reaches us.
        if (!hasFocus) stylusKeys.releaseAll().forEach(::emitStylus)
    }

    override fun onPause() {
        stylusKeys.releaseAll().forEach(::emitStylus)
        super.onPause()
    }

    private fun emitStylus(event: StylusButtonEvent) {
        inkstonePlugin()?.emitStylusButton(event)
    }

    private fun inkstonePlugin(): InkstoneNativePlugin? =
        bridge?.getPlugin(InkstoneNativePlugin.NAME)?.instance as? InkstoneNativePlugin

    /** Looked up once (the plugin lives as long as this activity's bridge), then cached. */
    private fun findPaperFeel(): NativePaperFeel? = inkstonePlugin()?.paperFeel?.also { paperFeel = it }

    private fun findInkTip(): NativeInkTip? = inkstonePlugin()?.inkTip?.also { inkTip = it }

    private fun preferHighestRefreshRate() {
        val display = currentDisplay() ?: return
        val modes = display.supportedModes ?: return
        val current = display.mode.toInfo()
        val best = RefreshRatePicker.pick(current, modes.map { it.toInfo() })
        val attrs = window.attributes
        // Set even when the panel is already at the best mode: adaptive-refresh panels may drop to
        // a lower rate when content is idle, and the stated preference is what holds it up.
        if (attrs.preferredDisplayModeId == best.id) return
        attrs.preferredDisplayModeId = best.id
        window.attributes = attrs
        Log.i(TAG, "Preferring display mode ${best.width}x${best.height} @ ${best.refreshRate} Hz")
    }

    private fun currentDisplay(): Display? =
        if (Build.VERSION.SDK_INT >= 30) {
            display
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay
        }

    private fun Display.Mode.toInfo() = DisplayModeInfo(modeId, physicalWidth, physicalHeight, refreshRate)

    // --- @capgo/capacitor-social-login: Google authorization (scopes) comes back here. ---

    @Deprecated("Required by @capgo/capacitor-social-login for Google scopes")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN || requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) return
        val plugin = bridge?.getPlugin("SocialLogin")?.instance
        if (plugin is SocialLoginPlugin) {
            plugin.handleGoogleLoginIntent(requestCode, data)
        } else {
            Log.w(TAG, "SocialLogin plugin not available for Google authorization result")
        }
    }

    override fun IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}

    private companion object {
        const val TAG = "Inkstone"

        /** Flip to false to restore Android's default once-per-frame input batching. */
        const val UNBUFFERED_POINTER_DISPATCH = true
    }
}
