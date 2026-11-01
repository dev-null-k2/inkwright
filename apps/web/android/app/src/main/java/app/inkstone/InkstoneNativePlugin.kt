package app.inkstone

import android.util.Log
import app.inkstone.feel.HapticGrainEngine
import app.inkstone.input.StylusButtonEvent
import app.inkstone.recognition.HandwritingRecognizer
import app.inkstone.recognition.InkPayload
import app.inkstone.recognition.LineInput
import app.inkstone.recognition.StrokeInput
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Inkstone's own Capacitor plugin. JS interface: apps/web/src/platform/native.ts.
 *
 *  - capabilities()                 → { richHaptics, recognition, stylusKeys }
 *  - grain({ intensity })           → paper-grain haptic tick (non-blocking)
 *  - confirm()                      → crisp confirmation tick (non-blocking)
 *  - prepareRecognizer({ language }) → { state: 'ready' | 'downloading' | 'failed' | 'unsupported' }
 *  - recognize({ language, lines }) → { lines: string[] } (ML Kit Digital Ink, on device)
 *  - event 'stylusButton'           → { pressed, keyCode } (forwarded by [MainActivity])
 */
@CapacitorPlugin(name = "InkstoneNative")
class InkstoneNativePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var haptics: HapticGrainEngine
    private lateinit var recognizer: HandwritingRecognizer

    override fun load() {
        haptics = HapticGrainEngine(context.applicationContext)
        recognizer = HandwritingRecognizer(scope)
    }

    override fun handleOnDestroy() {
        if (::haptics.isInitialized) haptics.release()
        if (::recognizer.isInitialized) recognizer.close()
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun capabilities(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("richHaptics", haptics.hasVibrator && haptics.supportsRichHaptics)
                .put("recognition", true)
                .put("stylusKeys", true),
        )
    }

    @PluginMethod
    fun grain(call: PluginCall) {
        val intensity = call.getDouble("intensity") ?: 0.5
        haptics.grain(intensity.toFloat())
        call.resolve()
    }

    @PluginMethod
    fun confirm(call: PluginCall) {
        haptics.confirm()
        call.resolve()
    }

    @PluginMethod
    fun prepareRecognizer(call: PluginCall) {
        val language = call.getString("language")?.takeIf { it.isNotBlank() } ?: DEFAULT_LANGUAGE
        scope.launch {
            val state = try {
                recognizer.prepare(language)
            } catch (e: Exception) {
                Log.w(TAG, "prepareRecognizer failed", e)
                HandwritingRecognizer.State.FAILED
            }
            call.resolve(JSObject().put("state", state.wire))
        }
    }

    @PluginMethod
    fun recognize(call: PluginCall) {
        val language = call.getString("language")?.takeIf { it.isNotBlank() } ?: DEFAULT_LANGUAGE
        val raw = call.getArray("lines")
        if (raw == null) {
            call.reject("'lines' is required", "INVALID_ARGUMENT")
            return
        }
        scope.launch {
            try {
                val lines = parseLines(raw)
                val text = recognizer.recognize(language, lines)
                call.resolve(JSObject().put("lines", JSArray(text)))
            } catch (e: HandwritingRecognizer.NotReadyException) {
                call.reject(e.message, "NOT_READY")
            } catch (e: Exception) {
                Log.w(TAG, "recognize failed", e)
                call.reject(e.message ?: "Recognition failed", "RECOGNITION_FAILED", e)
            }
        }
    }

    /** Called by [MainActivity] on the UI thread for stylus button key events. */
    fun emitStylusButton(event: StylusButtonEvent) {
        notifyListeners(
            EVENT_STYLUS_BUTTON,
            JSObject().put("pressed", event.pressed).put("keyCode", event.keyCode),
        )
    }

    private fun parseLines(raw: JSONArray): List<LineInput> {
        val out = ArrayList<LineInput>(raw.length())
        for (i in 0 until raw.length()) {
            val line = raw.optJSONObject(i) ?: continue
            val strokesJson = line.optJSONArray("strokes") ?: JSONArray()
            val strokes = ArrayList<StrokeInput>(strokesJson.length())
            for (j in 0 until strokesJson.length()) {
                val s = strokesJson.optJSONObject(j) ?: continue
                val x = s.doubles("x") ?: continue
                val y = s.doubles("y") ?: continue
                InkPayload.stroke(x, y, s.doubles("t"))?.let(strokes::add)
            }
            out += LineInput(
                strokes = strokes,
                width = line.optDouble("width", 0.0).toFloat(),
                height = line.optDouble("height", 0.0).toFloat(),
                preContext = line.optString("preContext", ""),
            )
        }
        return out
    }

    private fun JSONObject.doubles(key: String): DoubleArray? {
        val a = optJSONArray(key) ?: return null
        return DoubleArray(a.length()) { a.optDouble(it, Double.NaN) }
    }

    companion object {
        const val NAME = "InkstoneNative"
        const val EVENT_STYLUS_BUTTON = "stylusButton"
        private const val DEFAULT_LANGUAGE = "en-US"
        private const val TAG = "InkstoneNative"
    }
}
