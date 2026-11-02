package app.inkstone.ai

/**
 * Whether an on-device engine can answer, in the words the web layer uses (`NativeLLMAvailability`
 * in apps/web/src/platform/native-llm.ts): `available`, `downloadable`, `downloading`,
 * `unavailable`. Every engine (Gemini Nano through AICore, the ML Kit GenAI task APIs, a LiteRT-LM
 * model file) reports through this one type so the web layer needs no per-engine cases.
 */
enum class EngineState(val wire: String) {
    AVAILABLE("available"),
    DOWNLOADABLE("downloadable"),
    DOWNLOADING("downloading"),
    UNAVAILABLE("unavailable");

    companion object {
        // ML Kit GenAI's @FeatureStatus ints (com.google.mlkit.genai.common.FeatureStatus). Mirrored
        // here so the mapping is testable on the JVM; EngineStateTest pins them to the library's.
        const val FEATURE_UNAVAILABLE = 0
        const val FEATURE_DOWNLOADABLE = 1
        const val FEATURE_DOWNLOADING = 2
        const val FEATURE_AVAILABLE = 3

        /** Maps an ML Kit GenAI feature status. Unknown values (a newer AICore) count as unavailable. */
        fun fromFeatureStatus(status: Int): EngineState = when (status) {
            FEATURE_AVAILABLE -> AVAILABLE
            FEATURE_DOWNLOADABLE -> DOWNLOADABLE
            FEATURE_DOWNLOADING -> DOWNLOADING
            else -> UNAVAILABLE
        }

        /**
         * A LiteRT-LM model file's state: on disk and verified, being fetched, or fetchable. A model
         * the phone has too little memory for is unavailable even when its file is present.
         */
        fun forModelFile(installed: Boolean, downloading: Boolean, fits: Boolean): EngineState = when {
            !fits -> UNAVAILABLE
            downloading -> DOWNLOADING
            installed -> AVAILABLE
            else -> DOWNLOADABLE
        }
    }
}

/**
 * A failure the web layer can act on: [code] is stable (the JS bridge switches on it), [message]
 * is plain, sentence-case copy shown to the person, [retryable] says whether trying again later
 * can help (busy, quota) as opposed to never (unsupported device).
 */
class AiException(val code: String, message: String, val retryable: Boolean = false, cause: Throwable? = null) : Exception(message, cause)

/**
 * ML Kit GenAI / AICore error codes (GenAiException.ErrorCode) → [AiException]. Mirrored ints for
 * the same reason as [EngineState]; EngineStateTest pins them.
 */
object GenAiErrors {
    const val UNKNOWN = 0
    const val REQUEST_PROCESSING_ERROR = 4
    const val CANCELLED = 7
    const val NOT_AVAILABLE = 8
    const val BUSY = 9
    const val RESPONSE_PROCESSING_ERROR = 11
    const val REQUEST_TOO_LARGE = 12
    const val RESPONSE_GENERATION_ERROR = 15
    const val NOT_SUPPORTED = 16
    const val PER_APP_BATTERY_USE_QUOTA_EXCEEDED = 27
    const val BACKGROUND_USE_BLOCKED = 30
    const val NOT_ENOUGH_DISK_SPACE = 501
    const val NEEDS_SYSTEM_UPDATE = 604
    const val REQUEST_TOO_SMALL = -100
    const val AICORE_INCOMPATIBLE = -101
    const val INVALID_INPUT_IMAGE = -102
    const val MAX_TURNS_EXCEEDED = -112

    fun describe(errorCode: Int, detail: String? = null, cause: Throwable? = null): AiException = when (errorCode) {
        BUSY -> AiException("busy", "Gemini Nano is busy with another app. Try again in a moment.", retryable = true, cause = cause)
        PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> AiException("quota", "Android paused on-device AI for Inkstone to save battery. Try again later.", retryable = true, cause = cause)
        BACKGROUND_USE_BLOCKED -> AiException("background", "On-device AI only runs while Inkstone is on screen.", retryable = true, cause = cause)
        NOT_ENOUGH_DISK_SPACE -> AiException("disk", "Not enough free storage for Gemini Nano. Free some space and try again.", cause = cause)
        NEEDS_SYSTEM_UPDATE, AICORE_INCOMPATIBLE -> AiException("update", "Update Android System Intelligence (AICore) from the Play Store to use Gemini Nano.", cause = cause)
        NOT_SUPPORTED, NOT_AVAILABLE -> AiException("unsupported", "Gemini Nano isn’t available on this phone.", cause = cause)
        REQUEST_TOO_LARGE, MAX_TURNS_EXCEEDED -> AiException("too-large", "That’s more text than Gemini Nano can read at once. Try a shorter note or a new conversation.", cause = cause)
        REQUEST_TOO_SMALL -> AiException("too-small", "There isn’t enough text for this yet.", cause = cause)
        INVALID_INPUT_IMAGE -> AiException("bad-image", "Gemini Nano couldn’t read that image.", cause = cause)
        CANCELLED -> AiException("cancelled", "Stopped.", cause = cause)
        else -> AiException("failed", "On-device AI failed${detail?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: "."}", retryable = true, cause = cause)
    }
}
