package app.inkwright.ai

/**
 * The bookkeeping of a resumable model download, kept free of I/O so it can be tested: what to
 * ask the server for given what is already on disk, and what to do with each answer.
 *
 * A download writes `<file>.part`; bytes already there are kept across app restarts and network
 * drops and the next attempt asks for the rest with a `Range` header. Servers may ignore the range
 * (200: start over), honour it (206 from where we asked: append), answer from somewhere else
 * (206 elsewhere: start over), or say there is nothing left (416 at the end: done). The expected
 * size comes from the pinned catalog entry, so a server that suddenly reports another total means
 * the file is not the one we pinned and the download fails instead of producing a corrupt model.
 */
object DownloadPlan {
    sealed class Start {
        /** Nothing usable on disk: request the whole file. */
        object Fresh : Start()

        /** Ask for bytes from [from] on. */
        data class Resume(val from: Long) : Start()

        /** The part file already has every byte: just verify it. */
        object Complete : Start()
    }

    sealed class Next {
        /** Write the body after the [from] bytes already on disk. */
        data class Append(val from: Long) : Next()

        /** Truncate the part file and write the body from byte 0. */
        object Restart : Next()

        /** Nothing more to fetch. */
        object Done : Next()

        data class Fail(val code: String, val message: String) : Next()
    }

    data class ContentRange(val start: Long, val end: Long, val total: Long?)

    fun start(partBytes: Long, expectedTotal: Long): Start = when {
        partBytes <= 0L || partBytes > expectedTotal -> Start.Fresh
        partBytes == expectedTotal -> Start.Complete
        else -> Start.Resume(partBytes)
    }

    fun rangeHeader(from: Long): String = "bytes=$from-"

    /** Parses `bytes 100-199/1000` (total may be `*`). Null when malformed. */
    fun parseContentRange(header: String?): ContentRange? {
        val m = Regex("""^\s*bytes\s+(\d+)-(\d+)/(\d+|\*)\s*$""", RegexOption.IGNORE_CASE).find(header ?: return null) ?: return null
        val start = m.groupValues[1].toLongOrNull() ?: return null
        val end = m.groupValues[2].toLongOrNull() ?: return null
        if (end < start) return null
        return ContentRange(start, end, m.groupValues[3].toLongOrNull())
    }

    /**
     * What to do with a response to a request for bytes from [requestedFrom] (0 = whole file).
     * [contentLength] is -1 when the server didn't say.
     */
    fun onResponse(requestedFrom: Long, status: Int, contentRange: String?, contentLength: Long, expectedTotal: Long): Next = when (status) {
        206 -> {
            val r = parseContentRange(contentRange)
            when {
                r == null -> Next.Fail("bad-response", "The download server sent an unreadable reply.")
                r.total != null && r.total != expectedTotal -> Next.Fail("changed", "The model file on the server isn’t the expected one.")
                r.start == requestedFrom -> Next.Append(requestedFrom)
                r.start == 0L -> Next.Restart
                else -> Next.Fail("bad-response", "The download server sent the wrong part of the file.")
            }
        }
        200 -> when {
            contentLength >= 0 && contentLength != expectedTotal -> Next.Fail("changed", "The model file on the server isn’t the expected one.")
            else -> Next.Restart
        }
        416 -> if (requestedFrom >= expectedTotal) Next.Done else Next.Restart
        401, 403 -> Next.Fail("forbidden", "The model host refused the download.")
        404, 410 -> Next.Fail("gone", "This model is no longer at its download address. Update Inkwright to get the current one.")
        429, 500, 502, 503, 504 -> Next.Fail("server", "The model host is busy. Try again in a few minutes.")
        else -> Next.Fail("http", "Download failed (HTTP $status).")
    }

    /**
     * Whether [remaining] more bytes fit in [free] bytes of storage, leaving [reserve] for the
     * system and the vault (running a phone out of storage corrupts other apps' writes).
     */
    fun hasRoom(remaining: Long, free: Long, reserve: Long = 512L * 1024 * 1024): Boolean = free - remaining >= reserve
}

/**
 * Limits progress events to one per [minIntervalMs] (and always the first and the last), so a
 * 2 GB download doesn't send thousands of events through the WebView bridge.
 */
class ProgressThrottle(private val clock: () -> Long = System::currentTimeMillis, private val minIntervalMs: Long = 250) {
    private var last = Long.MIN_VALUE

    fun shouldReport(loaded: Long, total: Long): Boolean {
        val now = clock()
        if (last == Long.MIN_VALUE || loaded >= total || now - last >= minIntervalMs) {
            last = now
            return true
        }
        return false
    }
}
