package app.inkwright.ai

/**
 * The ML Kit GenAI task APIs Inkwright uses, and the pure mapping from what the web layer asks for
 * (a BCP-47 language, a summary style, a rewrite tone) to each API's option ints. The ints mirror
 * ML Kit's @IntDef annotations (SummarizerOptions, ProofreaderOptions, RewriterOptions); a test pins
 * them to the library so an SDK update that renumbers them fails the build's tests, not users.
 */
enum class GenAiTask(val wire: String) {
    SUMMARIZE("summarize"),
    PROOFREAD("proofread"),
    REWRITE("rewrite"),
    DESCRIBE_IMAGE("describe-image");

    companion object {
        fun fromWire(s: String?): GenAiTask? = entries.firstOrNull { it.wire == s }
    }
}

object TaskOptions {
    // Language ints shared by the three text APIs.
    const val LANG_ENGLISH = 0
    const val LANG_JAPANESE = 1
    const val LANG_KOREAN = 2
    const val LANG_GERMAN = 3
    const val LANG_FRENCH = 4
    const val LANG_ITALIAN = 5
    const val LANG_SPANISH = 6

    const val SUMMARY_INPUT_ARTICLE = 1
    const val SUMMARY_ONE_BULLET = 1
    const val SUMMARY_TWO_BULLETS = 2
    const val SUMMARY_THREE_BULLETS = 3

    const val PROOFREAD_INPUT_KEYBOARD = 1
    const val PROOFREAD_INPUT_VOICE = 2

    const val REWRITE_ELABORATE = 1
    const val REWRITE_EMOJIFY = 2
    const val REWRITE_SHORTEN = 3
    const val REWRITE_FRIENDLY = 4
    const val REWRITE_PROFESSIONAL = 5
    const val REWRITE_REPHRASE = 6

    private val byLanguage = mapOf(
        "en" to LANG_ENGLISH, "ja" to LANG_JAPANESE, "ko" to LANG_KOREAN,
        "de" to LANG_GERMAN, "fr" to LANG_FRENCH, "it" to LANG_ITALIAN, "es" to LANG_SPANISH,
    )

    /** Summarization only reads English, Japanese and Korean (ML Kit GenAI, late 2026). */
    private val summaryLanguages = setOf(LANG_ENGLISH, LANG_JAPANESE, LANG_KOREAN)

    /**
     * The ML Kit language for [tag] ("de-AT" → German), or null when [task] doesn't support it —
     * the caller then uses the Prompt API (or another engine) instead of producing English output
     * for, say, a Dutch note. Image description has no language option (English only): null for
     * anything but English.
     */
    fun language(task: GenAiTask, tag: String?): Int? {
        val l = byLanguage[(tag ?: "en").lowercase().split('-', '_').first()] ?: return null
        return when (task) {
            GenAiTask.SUMMARIZE -> l.takeIf { it in summaryLanguages }
            GenAiTask.DESCRIBE_IMAGE -> l.takeIf { it == LANG_ENGLISH }
            else -> l
        }
    }

    /** `short` → one bullet; anything else (`bullets`, `detailed`) → three, the API's maximum. */
    fun summaryOutput(style: String?): Int = when (style) {
        "short" -> SUMMARY_ONE_BULLET
        "two" -> SUMMARY_TWO_BULLETS
        else -> SUMMARY_THREE_BULLETS
    }

    /** `voice` for dictated text, otherwise keyboard-style input (handwriting recognition output reads like typing). */
    fun proofreadInput(kind: String?): Int = if (kind == "voice") PROOFREAD_INPUT_VOICE else PROOFREAD_INPUT_KEYBOARD

    fun rewriteOutput(tone: String?): Int? = when (tone) {
        "elaborate" -> REWRITE_ELABORATE
        "emojify" -> REWRITE_EMOJIFY
        "shorten" -> REWRITE_SHORTEN
        "friendly" -> REWRITE_FRIENDLY
        "professional" -> REWRITE_PROFESSIONAL
        "rephrase" -> REWRITE_REPHRASE
        else -> null
    }
}
