package app.inkwright.ai

/**
 * Turns an engine's stream of chunks into the deltas the web layer appends, and batches them.
 *
 * Why: engines disagree on what a chunk is. ML Kit's Prompt API and LiteRT-LM send new text only,
 * but some AICore builds and the task APIs' streaming callbacks have sent the whole text so far;
 * appending those would repeat the answer. And a token every ~20 ms is one Capacitor event each
 * (a JSON round trip through the WebView), so small deltas are coalesced: a batch is sent once it
 * has [minChars] characters or [maxDelayMs] passed since the last send, whichever comes first.
 *
 * Not thread-safe: feed it from one coroutine.
 */
class StreamAssembler(
    private val emit: (String) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    private val minChars: Int = 24,
    private val maxDelayMs: Long = 60,
) {
    private val text = StringBuilder()
    private val pending = StringBuilder()
    private var lastEmit = Long.MIN_VALUE

    /** Everything received so far. */
    val soFar: String get() = text.toString()

    /**
     * Adds a chunk. A chunk that starts with everything received so far (and is longer) is taken
     * as cumulative and only its new tail is used — but only once there is enough text for that to
     * be unambiguous (a short delta like "the" may legitimately start with a two-letter prefix).
     */
    fun push(chunk: String) {
        if (chunk.isEmpty()) return
        val delta = if (text.length >= CUMULATIVE_MIN && chunk.length > text.length && chunk.startsWith(text)) chunk.substring(text.length)
        else if (text.length >= CUMULATIVE_MIN && chunk == text.toString()) ""
        else chunk
        if (delta.isEmpty()) return
        text.append(delta)
        pending.append(delta)
        val now = clock()
        if (pending.length >= minChars || lastEmit == Long.MIN_VALUE || now - lastEmit >= maxDelayMs) flush(now)
    }

    /**
     * Ends the stream: sends what is pending and reconciles with the engine's [final] text when it
     * gives one (a final text that extends what was streamed sends the missing tail; one that
     * differs entirely wins, without re-sending). Returns the full answer.
     */
    fun finish(final: String? = null): String {
        if (final != null && final.length > text.length && final.startsWith(text)) {
            val tail = final.substring(text.length)
            text.append(tail)
            pending.append(tail)
        }
        flush(clock())
        return if (final != null && final.isNotEmpty() && !final.startsWith(text) && !text.startsWith(final)) final else text.toString()
    }

    private fun flush(now: Long) {
        if (pending.isEmpty()) return
        emit(pending.toString())
        pending.setLength(0)
        lastEmit = now
    }

    private companion object {
        const val CUMULATIVE_MIN = 16
    }
}
