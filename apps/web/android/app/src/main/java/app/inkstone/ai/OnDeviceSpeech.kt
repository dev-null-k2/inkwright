package app.inkstone.ai

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.FileOutputStream

/**
 * Speech to text with Android's own recognizer, kept on the phone:
 *  - Android 12+ with an on-device recognizer installed: [SpeechRecognizer.createOnDeviceSpeechRecognizer]
 *    (audio never leaves the phone — this is what `onDevice` reports);
 *  - otherwise the default recognition service with [RecognizerIntent.EXTRA_PREFER_OFFLINE], which
 *    stays offline when the language pack is installed but may use the network — reported as
 *    `onDevice: false` so the web layer can say so.
 *
 * Live sessions ([start]) listen to the microphone with partial results (push-to-talk in the
 * assistant). [transcribe] recognizes recorded PCM through [RecognizerIntent.EXTRA_AUDIO_SOURCE]
 * (Android 13+, on-device recognizer only), which implements the web layer's `Transcriber`.
 *
 * SpeechRecognizer must be created and driven on the main thread (Android requirement); those calls
 * only post messages to the recognition service, which does the work in its own process.
 */
class OnDeviceSpeech(private val context: Context, private val scope: CoroutineScope) {
    data class Status(val available: Boolean, val onDevice: Boolean, val fileInput: Boolean)

    fun status(): Status {
        val onDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        val any = onDevice || SpeechRecognizer.isRecognitionAvailable(context)
        return Status(available = any, onDevice = onDevice, fileInput = onDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
    }

    private fun create(): Pair<SpeechRecognizer, Boolean> {
        val s = status()
        if (!s.available) throw AiException("unsupported", "This phone has no speech recognition service.")
        return if (s.onDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) to true
        else SpeechRecognizer.createSpeechRecognizer(context) to false
    }

    private fun baseIntent(language: String?) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        if (!language.isNullOrBlank()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
    }

    /** One push-to-talk session. [stop] ends it and returns the transcript. */
    inner class Session internal constructor(private val onPartial: (String) -> Unit) {
        private val transcript = SpeechTranscript()
        private val done = CompletableDeferred<Result<String>>()
        private var recognizer: SpeechRecognizer? = null
        var onDevice = false
            private set

        internal fun begin(language: String?) {
            val (r, local) = create()
            recognizer = r
            onDevice = local
            r.setRecognitionListener(listener(transcript, done, onPartial))
            val intent = baseIntent(language)
            // Push-to-talk: keep listening through pauses until the person lets go (Android 13+).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS)
            }
            r.startListening(intent)
        }

        /** Stops listening and waits (briefly) for the final result. */
        suspend fun stop(): String {
            withContext(Dispatchers.Main) { recognizer?.stopListening() }
            val r = withTimeoutOrNull(STOP_TIMEOUT_MS) { done.await() } ?: Result.success(transcript.final(null))
            release()
            return r.getOrThrow()
        }

        suspend fun cancel() {
            withContext(Dispatchers.Main) { recognizer?.cancel() }
            done.complete(Result.success(""))
            release()
        }

        private suspend fun release() = withContext(Dispatchers.Main) {
            recognizer?.destroy()
            recognizer = null
        }
    }

    /** Starts a live session (call from any thread). */
    suspend fun start(language: String?, onPartial: (String) -> Unit): Session = withContext(Dispatchers.Main) {
        Session(onPartial).also { it.begin(language) }
    }

    /**
     * Recognizes 16-bit mono PCM ([sampleRate] Hz) on the device. Android 13+ with the on-device
     * recognizer only — elsewhere this throws `unsupported` and the web layer records with a
     * provider (or uses a live session) instead.
     */
    suspend fun transcribe(pcm: ByteArray, sampleRate: Int, language: String?): String {
        if (!status().fileInput || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            throw AiException("unsupported", "On-device transcription of recordings needs Android 13 or later with offline speech recognition.")
        }
        val transcript = SpeechTranscript()
        val done = CompletableDeferred<Result<String>>()
        val pipe = ParcelFileDescriptor.createPipe()
        val recognizer = withContext(Dispatchers.Main) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also { r ->
                r.setRecognitionListener(listener(transcript, done) {})
                val intent = baseIntent(language).apply {
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, sampleRate)
                    // The whole recording, through its pauses, in segments.
                    putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
                }
                r.startListening(intent)
            }
        }
        // Feed the audio from an IO thread; closing the write end tells the recognizer it's over.
        scope.launch(Dispatchers.IO) {
            runCatching { FileOutputStream(pipe[1].fileDescriptor).use { it.write(pcm) } }
            runCatching { pipe[1].close() }
        }
        val seconds = pcm.size / (2.0 * sampleRate)
        try {
            val r = withTimeoutOrNull(((seconds * 3) + 15).toLong() * 1000) { done.await() }
                ?: throw AiException("timeout", "Transcription took too long.", retryable = true)
            return r.getOrThrow()
        } finally {
            withContext(Dispatchers.Main) { recognizer.destroy() }
            runCatching { pipe[0].close() }
        }
    }

    private fun listener(t: SpeechTranscript, done: CompletableDeferred<Result<String>>, onPartial: (String) -> Unit) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            t.partial(first(partialResults))
            onPartial(t.live)
        }

        override fun onSegmentResults(segmentResults: Bundle) {
            t.segment(first(segmentResults))
            onPartial(t.live)
        }

        override fun onEndOfSegmentedSession() {
            done.complete(Result.success(t.final(null)))
        }

        override fun onResults(results: Bundle?) {
            done.complete(Result.success(t.final(first(results))))
        }

        override fun onError(error: Int) {
            if (SpeechErrors.isEmptyResult(error) || (error == SpeechErrors.CLIENT && t.live.isNotEmpty())) done.complete(Result.success(t.final(null)))
            else done.complete(Result.failure(SpeechErrors.describe(error)))
        }
    }

    private fun first(b: Bundle?): String? = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private companion object {
        const val STOP_TIMEOUT_MS = 4_000L
    }
}
