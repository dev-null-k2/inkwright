package app.inkwright.recognition

/** One stroke as plain arrays; [t] is null when the web layer sent no (or mismatched) timestamps. */
class StrokeInput(val x: FloatArray, val y: FloatArray, val t: LongArray?) {
    val size: Int get() = x.size
}

/** One written line to recognize, in page units. */
class LineInput(val strokes: List<StrokeInput>, val width: Float, val height: Float, val preContext: String)

/**
 * Pure helpers that turn the `recognize` payload into what ML Kit wants, kept free of Android
 * and ML Kit types so they can be unit-tested on the JVM.
 */
object InkPayload {
    /** ML Kit looks at roughly the last 20 characters of pre-context. */
    const val MAX_PRE_CONTEXT = 20

    /**
     * Normalizes one stroke: trims x/y to a common length, drops non-finite points, keeps
     * timestamps only if there is one per point. Returns null for an empty stroke.
     */
    fun stroke(x: DoubleArray, y: DoubleArray, t: DoubleArray?): StrokeInput? {
        val n = minOf(x.size, y.size)
        val withTime = t != null && t.size >= n
        val xs = FloatArray(n)
        val ys = FloatArray(n)
        val ts = if (withTime) LongArray(n) else null
        var k = 0
        for (i in 0 until n) {
            val px = x[i]
            val py = y[i]
            if (!px.isFinite() || !py.isFinite()) continue
            if (ts != null) {
                val pt = t!![i]
                if (!pt.isFinite()) continue
                ts[k] = pt.toLong()
            }
            xs[k] = px.toFloat()
            ys[k] = py.toFloat()
            k++
        }
        if (k == 0) return null
        return StrokeInput(xs.copyOf(k), ys.copyOf(k), ts?.let { fixTimestamps(it.copyOf(k)) })
    }

    /** ML Kit expects non-decreasing timestamps within a stroke; clamp any that go backwards. */
    private fun fixTimestamps(ts: LongArray): LongArray {
        for (i in 1 until ts.size) if (ts[i] < ts[i - 1]) ts[i] = ts[i - 1]
        return ts
    }

    /**
     * The text ML Kit should treat as written just before this line: the caller's pre-context if
     * it sent one, otherwise the previous recognized line followed by a space (a line break is a
     * word break), trimmed to the last [MAX_PRE_CONTEXT] characters.
     */
    fun preContext(explicit: String, previousLine: String): String {
        val raw = when {
            explicit.isNotEmpty() -> explicit
            previousLine.isBlank() -> ""
            previousLine.last().isWhitespace() -> previousLine
            else -> "$previousLine "
        }
        return if (raw.length <= MAX_PRE_CONTEXT) raw else raw.substring(raw.length - MAX_PRE_CONTEXT)
    }

    /** ML Kit's WritingArea must be positive; fall back to the ink's own extent when needed. */
    fun writingArea(width: Float, height: Float, strokes: List<StrokeInput>): Pair<Float, Float> {
        var w = if (width.isFinite()) width else 0f
        var h = if (height.isFinite()) height else 0f
        if (w <= 0f || h <= 0f) {
            var minX = Float.POSITIVE_INFINITY; var maxX = Float.NEGATIVE_INFINITY
            var minY = Float.POSITIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY
            for (s in strokes) for (i in 0 until s.size) {
                minX = minOf(minX, s.x[i]); maxX = maxOf(maxX, s.x[i])
                minY = minOf(minY, s.y[i]); maxY = maxOf(maxY, s.y[i])
            }
            if (w <= 0f) w = if (maxX >= minX) maxX - minX else 0f
            if (h <= 0f) h = if (maxY >= minY) maxY - minY else 0f
        }
        return Pair(w.coerceAtLeast(1f), h.coerceAtLeast(1f))
    }

    /**
     * Picks a language tag ML Kit may know: the tag as given, then its base language
     * ("pt-BR" → "pt"). [isSupported] is ML Kit's lookup, injected for tests.
     */
    fun resolveLanguage(tag: String, isSupported: (String) -> Boolean): String? {
        val cleaned = tag.trim().replace('_', '-')
        if (cleaned.isEmpty()) return null
        if (isSupported(cleaned)) return cleaned
        val base = cleaned.substringBefore('-')
        if (base != cleaned && isSupported(base)) return base
        return null
    }
}
