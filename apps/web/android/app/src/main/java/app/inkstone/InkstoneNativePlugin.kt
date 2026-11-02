package app.inkstone

import android.Manifest
import android.content.Intent
import android.util.Log
import app.inkstone.ai.AiBridge
import app.inkstone.files.IncomingFiles
import app.inkstone.feel.FeelProfile
import app.inkstone.feel.FeelSettings
import app.inkstone.feel.HapticGrainEngine
import app.inkstone.feel.NativePaperFeel
import app.inkstone.ink.NativeInkTip
import app.inkstone.input.StylusButtonEvent
import app.inkstone.recognition.HandwritingRecognizer
import app.inkstone.recognition.InkPayload
import app.inkstone.recognition.LineInput
import app.inkstone.recognition.StrokeInput
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PermissionState
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Inkstone's own Capacitor plugin. JS interface: apps/web/src/platform/native.ts.
 *
 *  - capabilities()                 → { richHaptics, recognition, stylusKeys, nativeFeel, inkTip }
 *  - feelBegin({ profile, sound, soundGain, haptics, hapticStrength, pressure })
 *                                   → arms the native paper feel (writing sound + haptic grain,
 *                                     read straight from the stylus's MotionEvents) for the pen
 *                                     stroke that just started, until the stylus lifts or feelEnd()
 *  - feelEnd()                      → silences (the release tail plays out) and disarms
 *  - feelPrepare({ active })        → opens (a note opened) or releases the low-latency sound stream
 *  - feelPreview({ profile, soundGain, haptics, hapticStrength }) → ~700 ms sample stroke
 *  - inkTipPrepare({ active })      → { supported }: attaches (a note opened) or removes (closed) the
 *                                     instant-ink-tip overlay, a transparent front-buffered surface
 *                                     above the WebView (Android 10+; see [NativeInkTip])
 *  - inkTipBegin({ color, widthPx, tailMs }) → until the web ink catches up, the pen stroke that just
 *                                     started is drawn natively from the stylus's MotionEvents: its
 *                                     newest tailMs plus a predicted point, "#AARRGGBB", CSS px wide
 *  - inkTipEnd({ cancelled })       → cancelled: clear now; otherwise the final tail lingers ~60 ms
 *  - grain({ intensity })           → paper-grain haptic tick (non-blocking; web path, finger drawing)
 *  - confirm()                      → crisp confirmation tick (non-blocking)
 *  - prepareRecognizer({ language }) → { state: 'ready' | 'downloading' | 'failed' | 'unsupported' }
 *  - recognize({ language, lines }) → { lines: string[] } (ML Kit Digital Ink, on device)
 *  - event 'stylusButton'           → { pressed, keyCode } (forwarded by [MainActivity])
 *  - takeSharedFiles()              → { files: [{ name, mimeType, path }] } files Android opened or
 *                                     shared to Inkstone, copied into the cache (see [IncomingFiles])
 *  - event 'sharedFiles'            → { files } the same, for files arriving while Inkstone runs
 *
 *  - ai* / speech*                  → on-device AI (Gemini Nano, ML Kit GenAI tasks, LiteRT-LM models,
 *                                     offline speech recognition); documented in [AiBridge]
 *
 * All feel* and inkTip* methods resolve at once (inkTipPrepare once the overlay's surface is up);
 * the work is posted to the UI thread (see [NativePaperFeel], [NativeInkTip]).
 */
@CapacitorPlugin(
    name = "InkstoneNative",
    permissions = [Permission(alias = InkstoneNativePlugin.MICROPHONE, strings = [Manifest.permission.RECORD_AUDIO])],
)
class InkstoneNativePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var haptics: HapticGrainEngine
    private lateinit var recognizer: HandwritingRecognizer
    private lateinit var ai: AiBridge

    /** The native paper-feel engine; [MainActivity] feeds it every MotionEvent. Null until [load]. */
    var paperFeel: NativePaperFeel? = null
        private set

    /** The instant ink tip; [MainActivity] feeds it every MotionEvent. Null until [load]. */
    var inkTip: NativeInkTip? = null
        private set

    /** Incoming files the web layer hasn't taken yet (it wasn't listening when they arrived). */
    private val pendingFiles = ArrayList<IncomingFiles.Incoming>()

    override fun load() {
        haptics = HapticGrainEngine(context.applicationContext)
        recognizer = HandwritingRecognizer(scope)
        paperFeel = NativePaperFeel(context.applicationContext, haptics)
        inkTip = NativeInkTip { bridge?.webView }
        ai = AiBridge(context.applicationContext, scope) { event, data -> notifyListeners(event, data) }
        // Launched by "Open with" / share: the intent that started the activity.
        activity?.intent?.let(::receive)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        receive(intent)
    }

    /** Copies an intent's files off the main thread, then hands them to the web layer. */
    private fun receive(intent: Intent) {
        if (!IncomingFiles.isIncoming(intent)) return
        val copy = Intent(intent)
        // Consumed: a later re-delivery of the same intent must not import it twice.
        if (activity?.intent === intent) activity?.intent = Intent(Intent.ACTION_MAIN)
        scope.launch {
            val files = withContext(Dispatchers.IO) { IncomingFiles.copyAll(context.applicationContext, copy) }
            if (files.isEmpty()) return@launch
            withContext(Dispatchers.Main) {
                if (hasListeners(EVENT_SHARED_FILES)) notifyListeners(EVENT_SHARED_FILES, JSObject().put("files", filesJson(files)))
                else synchronized(pendingFiles) { pendingFiles += files }
            }
        }
    }

    @PluginMethod
    fun takeSharedFiles(call: PluginCall) {
        val files = synchronized(pendingFiles) { pendingFiles.toList().also { pendingFiles.clear() } }
        call.resolve(JSObject().put("files", filesJson(files)))
    }

    private fun filesJson(files: List<IncomingFiles.Incoming>) = JSArray().apply {
        files.forEach { put(JSObject().put("name", it.name).put("mimeType", it.mimeType).put("path", it.path)) }
    }

    override fun handleOnPause() {
        paperFeel?.onHostPause()
        inkTip?.onHostPause()
        super.handleOnPause()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        paperFeel?.onHostResume()
        inkTip?.onHostResume()
    }

    override fun handleOnDestroy() {
        paperFeel?.release()
        inkTip?.release()
        if (::haptics.isInitialized) haptics.release()
        if (::recognizer.isInitialized) recognizer.close()
        if (::ai.isInitialized) ai.close()
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun capabilities(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("richHaptics", haptics.hasVibrator && haptics.supportsRichHaptics)
                .put("recognition", true)
                .put("stylusKeys", true)
                .put("nativeFeel", paperFeel != null)
                .put("inkTip", inkTip?.isSupported == true),
        )
    }

    /**
     * Opens the calendar app's "new event" screen prefilled (title, begin/end epoch ms, all-day),
     * for a date circled in a note. Resolves { opened: false } when no calendar app handles it.
     */
    @PluginMethod
    fun insertCalendarEvent(call: PluginCall) {
        val begin = call.getLong("beginTime") ?: return call.reject("beginTime is required")
        val intent = app.inkstone.calendar.CalendarIntents.insert(
            app.inkstone.calendar.CalendarIntents.Event(
                title = call.getString("title") ?: "",
                beginMs = begin,
                endMs = call.getLong("endTime") ?: (begin + 3_600_000L),
                allDay = call.getBoolean("allDay", false) ?: false,
                description = call.getString("description"),
                location = call.getString("location"),
            ),
        )
        try {
            (activity ?: context).startActivity(intent)
            call.resolve(JSObject().put("opened", true))
        } catch (e: android.content.ActivityNotFoundException) {
            call.resolve(JSObject().put("opened", false))
        }
    }

    @PluginMethod
    fun feelBegin(call: PluginCall) {
        val data = call.data
        paperFeel?.begin(feelSettings(data, sound = data.optBoolean("sound", true)), finiteOr(data.optDouble("pressure"), -1.0))
        call.resolve()
    }

    @PluginMethod
    fun feelEnd(call: PluginCall) {
        paperFeel?.end()
        call.resolve()
    }

    @PluginMethod
    fun feelPrepare(call: PluginCall) {
        paperFeel?.prepare(call.data.optBoolean("active", true))
        call.resolve()
    }

    @PluginMethod
    fun feelPreview(call: PluginCall) {
        paperFeel?.preview(feelSettings(call.data, sound = true)) // soundGain 0 = sound off
        call.resolve()
    }

    @PluginMethod
    fun inkTipPrepare(call: PluginCall) {
        val tip = inkTip
        if (tip == null) {
            call.resolve(JSObject().put("supported", false))
            return
        }
        tip.prepare(call.data.optBoolean("active", true)) { supported ->
            call.resolve(JSObject().put("supported", supported))
        }
    }

    @PluginMethod
    fun inkTipBegin(call: PluginCall) {
        val data = call.data
        // Junk (a missing or non-string colour, a non-numeric width) is rejected by InkTipStyle.from.
        inkTip?.begin(data.opt("color") as? String, data.optDouble("widthPx"), data.optDouble("tailMs"))
        call.resolve()
    }

    @PluginMethod
    fun inkTipEnd(call: PluginCall) {
        inkTip?.end(call.data.optBoolean("cancelled", false))
        call.resolve()
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

    // ---- On-device AI (see AiBridge for the wire format) ------------------------------------------

    @PluginMethod fun aiStatus(call: PluginCall) = ai.status(call)
    @PluginMethod fun aiDownload(call: PluginCall) = ai.download(call)
    @PluginMethod fun aiCancelDownload(call: PluginCall) = ai.cancelDownload(call)
    @PluginMethod fun aiDeleteModel(call: PluginCall) = ai.deleteModel(call)
    @PluginMethod fun aiUnload(call: PluginCall) = ai.unload(call)
    @PluginMethod fun aiGenerate(call: PluginCall) = ai.generate(call)
    @PluginMethod fun aiTask(call: PluginCall) = ai.task(call)
    @PluginMethod fun aiCancel(call: PluginCall) = ai.cancel(call)
    @PluginMethod fun speechStop(call: PluginCall) = ai.speechStop(call)
    @PluginMethod fun speechCancel(call: PluginCall) = ai.speechCancel(call)
    @PluginMethod fun speechTranscribe(call: PluginCall) = ai.speechTranscribe(call)

    /** Live recognition needs RECORD_AUDIO; asks for it first when the WebView never did. */
    @PluginMethod
    fun speechStart(call: PluginCall) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) ai.speechStart(call)
        else requestPermissionForAlias(MICROPHONE, call, "onMicrophonePermission")
    }

    @PermissionCallback
    private fun onMicrophonePermission(call: PluginCall) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) ai.speechStart(call)
        else call.reject("Inkstone needs microphone access for voice input. Allow it in Android’s app settings.", "permission")
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

    /** feelBegin / feelPreview options. Numbers are read leniently (any JSON number) and clamped. */
    private fun feelSettings(data: JSONObject, sound: Boolean) = FeelSettings(
        profile = FeelProfile.fromJson(data.optJSONObject("profile")),
        sound = sound,
        soundGain = finiteOr(data.optDouble("soundGain"), 0.0).coerceIn(0.0, 1.0),
        haptics = data.optBoolean("haptics", true),
        hapticStrength = finiteOr(data.optDouble("hapticStrength"), 1.0).coerceIn(0.0, 1.0),
    )

    private fun finiteOr(v: Double, fallback: Double) = if (v.isFinite()) v else fallback

    private fun JSONObject.doubles(key: String): DoubleArray? {
        val a = optJSONArray(key) ?: return null
        return DoubleArray(a.length()) { a.optDouble(it, Double.NaN) }
    }

    companion object {
        const val NAME = "InkstoneNative"
        const val MICROPHONE = "microphone"
        const val EVENT_STYLUS_BUTTON = "stylusButton"
        const val EVENT_SHARED_FILES = "sharedFiles"
        private const val DEFAULT_LANGUAGE = "en-US"
        private const val TAG = "InkstoneNative"
    }
}
