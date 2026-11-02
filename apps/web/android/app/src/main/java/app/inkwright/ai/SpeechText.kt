package app.inkwright.ai

/**
 * Pure helpers for on-device speech recognition ([OnDeviceSpeech]): putting a transcript together
 * from Android's partial, segment and final results, and turning SpeechRecognizer error codes into
 * outcomes. Kept apart from the Android classes so the rules are unit-tested.
 */
class SpeechTranscript {
    private val segments = ArrayList<String>()
    private var partial = ""

    /** The current hypothesis for the words being spoken now (replaces the previous one). */
    fun partial(text: String?) {
        partial = text?.trim().orEmpty()
    }

    /** A finished segment (segmented sessions, Android 13+): kept, and the partial is cleared. */
    fun segment(text: String?) {
        text?.trim()?.takeIf { it.isNotEmpty() }?.let(segments::add)
        partial = ""
    }

    /** What to show while listening: finished segments plus the live hypothesis. */
    val live: String get() = join(segments + listOfNotNull(partial.takeIf { it.isNotEmpty() }))

    /**
     * The final transcript. A recognizer's final result covers the current segment (or, without
     * segments, the whole utterance) and wins over the partial; with no final result (stopped by an
     * error after speech) the last partial is kept rather than losing what was said.
     */
    fun final(text: String?): String = join(segments + listOfNotNull((text?.trim()?.takeIf { it.isNotEmpty() } ?: partial).takeIf { it.isNotEmpty() }))

    private fun join(parts: List<String>) = parts.joinToString(" ").replace(Regex("\\s+"), " ").trim()
}

object SpeechErrors {
    // android.speech.SpeechRecognizer.ERROR_* (pinned by SpeechTextTest against the SDK constants).
    const val NETWORK_TIMEOUT = 1
    const val NETWORK = 2
    const val AUDIO = 3
    const val SERVER = 4
    const val CLIENT = 5
    const val SPEECH_TIMEOUT = 6
    const val NO_MATCH = 7
    const val RECOGNIZER_BUSY = 8
    const val INSUFFICIENT_PERMISSIONS = 9
    const val TOO_MANY_REQUESTS = 10
    const val SERVER_DISCONNECTED = 11
    const val LANGUAGE_NOT_SUPPORTED = 12
    const val LANGUAGE_UNAVAILABLE = 13
    const val CANNOT_CHECK_SUPPORT = 14
    const val CANNOT_LISTEN_TO_DOWNLOAD_EVENTS = 15

    /** Silence or nothing recognized ends a session normally, with whatever was heard (maybe nothing). */
    fun isEmptyResult(code: Int) = code == NO_MATCH || code == SPEECH_TIMEOUT

    fun describe(code: Int): AiException = when (code) {
        INSUFFICIENT_PERMISSIONS -> AiException("permission", "Inkwright needs microphone access for voice input. Allow it in Android’s app settings.")
        LANGUAGE_NOT_SUPPORTED -> AiException("language", "On-device speech recognition doesn’t support this language.")
        LANGUAGE_UNAVAILABLE -> AiException("language-download", "The speech model for this language isn’t on the phone yet. Android is downloading it; try again shortly.", retryable = true)
        RECOGNIZER_BUSY -> AiException("busy", "Speech recognition is busy. Try again in a moment.", retryable = true)
        AUDIO -> AiException("audio", "The microphone couldn’t be used. Another app may be recording.", retryable = true)
        NETWORK, NETWORK_TIMEOUT, SERVER, SERVER_DISCONNECTED, TOO_MANY_REQUESTS ->
            AiException("network", "Speech recognition needed the network and couldn’t reach it.", retryable = true)
        else -> AiException("failed", "Speech recognition failed (error $code).", retryable = true)
    }
}
