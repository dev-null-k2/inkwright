package app.inkwright.ai

import org.junit.Assert.assertEquals
import org.junit.Test

class StreamAssemblerTest {
    private var now = 0L
    private val sent = ArrayList<String>()
    private fun assembler(minChars: Int = 10, maxDelayMs: Long = 50) = StreamAssembler(emit = { sent += it }, clock = { now }, minChars = minChars, maxDelayMs = maxDelayMs)

    @Test
    fun deltasAreAppendedAndTheFirstGoesOutAtOnce() {
        val a = assembler()
        a.push("Hel")
        assertEquals(listOf("Hel"), sent) // time to first token matters most
        a.push("lo")
        a.push(", wor")
        assertEquals(listOf("Hel"), sent) // batched: under minChars and under maxDelay
        now += 60
        a.push("ld")
        assertEquals(listOf("Hel", "lo, world"), sent)
        assertEquals("Hello, world", a.finish())
    }

    @Test
    fun batchesFlushOnSize() {
        val a = assembler(minChars = 5, maxDelayMs = 10_000)
        a.push("a")
        a.push("bcd")
        a.push("efgh")
        assertEquals(listOf("a", "bcdefgh"), sent)
    }

    @Test
    fun cumulativeChunksOnlyContributeTheirNewTail() {
        val a = assembler(minChars = 1)
        a.push("The meeting is on")
        a.push("The meeting is on Tuesday")
        a.push("The meeting is on Tuesday at 3.")
        assertEquals("The meeting is on Tuesday at 3.", a.finish())
        assertEquals(listOf("The meeting is on", " Tuesday", " at 3."), sent)
    }

    @Test
    fun shortTextIsNeverMistakenForCumulative() {
        // "a" then "ab" are two deltas ("a" + "ab" = "aab"), not a cumulative stream.
        val a = assembler(minChars = 1)
        a.push("a")
        a.push("ab")
        assertEquals("aab", a.finish())
    }

    @Test
    fun repeatedFullTextIsIgnored() {
        val a = assembler(minChars = 1)
        a.push("A sixteen+ character answer.")
        a.push("A sixteen+ character answer.")
        assertEquals("A sixteen+ character answer.", a.finish())
        assertEquals(1, sent.size)
    }

    @Test
    fun finishSendsPendingTextAndReconcilesWithTheFinalAnswer() {
        val a = assembler(minChars = 100, maxDelayMs = 10_000)
        a.push("Sum")
        a.push("mary")
        assertEquals("Summary: done", a.finish("Summary: done"))
        assertEquals(listOf("Sum", "mary: done"), sent)
    }

    @Test
    fun aDifferentFinalAnswerWinsWithoutResending() {
        val a = assembler(minChars = 1)
        a.push("draft")
        assertEquals("Final text", a.finish("Final text"))
        assertEquals(listOf("draft"), sent)
        // A final that is a prefix of what streamed (e.g. trimmed) keeps the streamed text.
        val b = assembler(minChars = 1)
        b.push("answer  ")
        assertEquals("answer  ", b.finish("answer"))
    }

    @Test
    fun emptyChunksAndEmptyStreams() {
        val a = assembler()
        a.push("")
        assertEquals("", a.finish())
        assertEquals(emptyList<String>(), sent)
    }
}
