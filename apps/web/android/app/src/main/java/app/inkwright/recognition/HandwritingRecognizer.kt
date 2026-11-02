package app.inkwright.recognition

import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognition
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModel
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModelIdentifier
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizer
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizerOptions
import com.google.mlkit.vision.digitalink.recognition.Ink
import com.google.mlkit.vision.digitalink.recognition.RecognitionContext
import com.google.mlkit.vision.digitalink.recognition.WritingArea
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * On-device handwriting recognition with ML Kit Digital Ink. Ink never leaves the phone; only the
 * language model (~20 MB per language) is downloaded, once.
 *
 * [prepare] never waits for a download: it starts one in [scope] and reports `DOWNLOADING`, so
 * the web layer can fall back to another engine until the model is there.
 */
class HandwritingRecognizer(private val scope: CoroutineScope) {
    enum class State(val wire: String) {
        READY("ready"), DOWNLOADING("downloading"), FAILED("failed"), UNSUPPORTED("unsupported"),
    }

    class NotReadyException(val state: State, message: String) : Exception(message)

    private val mutex = Mutex()
    private var activeTag: String? = null
    private var recognizer: DigitalInkRecognizer? = null
    private val downloads = HashMap<String, Job>()
    private val failures = HashMap<String, Int>()
    private val manager by lazy { RemoteModelManager.getInstance() }

    /** Makes the model for [languageTag] usable, or starts getting it. */
    suspend fun prepare(languageTag: String): State {
        val tag = resolve(languageTag) ?: return State.UNSUPPORTED
        mutex.withLock {
            if (activeTag == tag && recognizer != null) return State.READY
            if (downloads[tag]?.isActive == true) return State.DOWNLOADING
        }
        val model = modelFor(tag) ?: return State.UNSUPPORTED
        val present = runCatching { manager.isModelDownloaded(model).await() == true }.getOrDefault(false)
        if (present) {
            mutex.withLock { activate(tag, model) }
            return State.READY
        }
        return mutex.withLock {
            when {
                downloads[tag]?.isActive == true -> State.DOWNLOADING
                (failures[tag] ?: 0) >= MAX_DOWNLOAD_ATTEMPTS -> State.FAILED
                else -> {
                    downloads[tag] = scope.launch { download(tag, model) }
                    State.DOWNLOADING
                }
            }
        }
    }

    /**
     * Recognizes each line, giving ML Kit the previous recognized line as pre-context (markedly
     * better than recognizing a page as one blob). Returns one string per input line ("" when
     * nothing was recognized). Throws [NotReadyException] if the model is not on the device.
     */
    suspend fun recognize(languageTag: String, lines: List<LineInput>): List<String> {
        val state = prepare(languageTag)
        if (state != State.READY) throw NotReadyException(state, "Handwriting model for '$languageTag' is ${state.wire}")
        return mutex.withLock {
            val r = recognizer ?: throw NotReadyException(State.FAILED, "Recognizer closed")
            val out = ArrayList<String>(lines.size)
            var previous = ""
            for (line in lines) {
                val text = recognizeLine(r, line, previous)
                out += text
                if (text.isNotBlank()) previous = text
            }
            out
        }
    }

    fun close() {
        recognizer?.close()
        recognizer = null
        activeTag = null
        downloads.values.forEach { it.cancel() }
        downloads.clear()
    }

    private suspend fun recognizeLine(r: DigitalInkRecognizer, line: LineInput, previous: String): String {
        if (line.strokes.isEmpty()) return ""
        val ink = Ink.builder()
        for (s in line.strokes) {
            val sb = Ink.Stroke.builder()
            val t = s.t
            for (i in 0 until s.size) {
                sb.addPoint(if (t != null) Ink.Point.create(s.x[i], s.y[i], t[i]) else Ink.Point.create(s.x[i], s.y[i]))
            }
            ink.addStroke(sb.build())
        }
        val (w, h) = InkPayload.writingArea(line.width, line.height, line.strokes)
        val context = RecognitionContext.builder()
            .setPreContext(InkPayload.preContext(line.preContext, previous))
            .setWritingArea(WritingArea(w, h))
            .build()
        return try {
            r.recognize(ink.build(), context).await()?.candidates?.firstOrNull()?.text.orEmpty()
        } catch (e: Exception) {
            Log.w(TAG, "Line recognition failed", e)
            ""
        }
    }

    private suspend fun download(tag: String, model: DigitalInkRecognitionModel) {
        try {
            manager.download(model, DownloadConditions.Builder().build()).await()
            mutex.withLock {
                failures.remove(tag)
                // Activate unless the user has since switched to another language.
                if (activeTag == null || activeTag == tag) activate(tag, model)
            }
            Log.i(TAG, "Handwriting model '$tag' downloaded")
        } catch (e: Exception) {
            mutex.withLock { failures[tag] = (failures[tag] ?: 0) + 1 }
            Log.w(TAG, "Handwriting model '$tag' download failed", e)
        } finally {
            mutex.withLock { downloads.remove(tag) }
        }
    }

    /** Caller holds [mutex]. */
    private fun activate(tag: String, model: DigitalInkRecognitionModel) {
        if (activeTag == tag && recognizer != null) return
        recognizer?.close()
        recognizer = DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(model).build())
        activeTag = tag
    }

    private fun resolve(tag: String): String? = InkPayload.resolveLanguage(tag) { identifierFor(it) != null }

    private fun modelFor(tag: String): DigitalInkRecognitionModel? =
        identifierFor(tag)?.let { DigitalInkRecognitionModel.builder(it).build() }

    private fun identifierFor(tag: String): DigitalInkRecognitionModelIdentifier? =
        try {
            DigitalInkRecognitionModelIdentifier.fromLanguageTag(tag)
        } catch (_: Exception) {
            null // malformed tag
        }

    private companion object {
        const val TAG = "InkwrightRecognizer"
        const val MAX_DOWNLOAD_ATTEMPTS = 3

        /** Completes Task callbacks on whichever thread ML Kit uses; resume() hops back to our dispatcher. */
        val direct = Executor { it.run() }

        suspend fun <T> Task<T>.await(): T? = suspendCancellableCoroutine { cont ->
            addOnCompleteListener(direct) { task ->
                if (!cont.isActive) return@addOnCompleteListener
                val error = task.exception
                when {
                    task.isCanceled -> cont.resumeWithException(java.util.concurrent.CancellationException("Task cancelled"))
                    error != null -> cont.resumeWithException(error)
                    else -> cont.resume(task.result)
                }
            }
        }
    }
}
