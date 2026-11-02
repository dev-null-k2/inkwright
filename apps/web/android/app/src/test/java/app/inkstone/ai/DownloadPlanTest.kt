package app.inkstone.ai

import app.inkstone.ai.DownloadPlan.Next
import app.inkstone.ai.DownloadPlan.Start
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadPlanTest {
    private val total = 1_000L

    @Test
    fun startFromWhatIsOnDisk() {
        assertEquals(Start.Fresh, DownloadPlan.start(0, total))
        assertEquals(Start.Resume(400), DownloadPlan.start(400, total))
        assertEquals(Start.Complete, DownloadPlan.start(total, total))
        // A part file larger than the model can only be garbage: start over.
        assertEquals(Start.Fresh, DownloadPlan.start(total + 1, total))
        assertEquals("bytes=400-", DownloadPlan.rangeHeader(400))
    }

    @Test
    fun parsesContentRange() {
        assertEquals(DownloadPlan.ContentRange(100, 115, 497_516_544), DownloadPlan.parseContentRange("bytes 100-115/497516544"))
        assertEquals(DownloadPlan.ContentRange(0, 9, null), DownloadPlan.parseContentRange("bytes 0-9/*"))
        assertNull(DownloadPlan.parseContentRange(null))
        assertNull(DownloadPlan.parseContentRange("bytes */1000"))
        assertNull(DownloadPlan.parseContentRange("bytes 9-0/1000"))
        assertNull(DownloadPlan.parseContentRange("items 0-9/1000"))
    }

    @Test
    fun partialResponseFromWhereWeAskedAppends() {
        assertEquals(Next.Append(400), DownloadPlan.onResponse(400, 206, "bytes 400-999/1000", 600, total))
    }

    @Test
    fun serverIgnoringTheRangeRestarts() {
        assertEquals(Next.Restart, DownloadPlan.onResponse(400, 200, null, total, total))
        assertEquals(Next.Restart, DownloadPlan.onResponse(0, 200, null, -1, total))
        assertEquals(Next.Restart, DownloadPlan.onResponse(400, 206, "bytes 0-999/1000", total, total))
    }

    @Test
    fun aDifferentFileFailsInsteadOfCorruptingTheModel() {
        assertEquals("changed", (DownloadPlan.onResponse(0, 200, null, 2_000, total) as Next.Fail).code)
        assertEquals("changed", (DownloadPlan.onResponse(400, 206, "bytes 400-1999/2000", 1600, total) as Next.Fail).code)
        assertEquals("bad-response", (DownloadPlan.onResponse(400, 206, "bytes 500-999/1000", 500, total) as Next.Fail).code)
        assertEquals("bad-response", (DownloadPlan.onResponse(400, 206, null, 600, total) as Next.Fail).code)
    }

    @Test
    fun rangeNotSatisfiable() {
        assertEquals(Next.Done, DownloadPlan.onResponse(total, 416, null, -1, total))
        assertEquals(Next.Restart, DownloadPlan.onResponse(400, 416, null, -1, total))
    }

    @Test
    fun httpErrorsHaveActionableCodes() {
        assertEquals("gone", (DownloadPlan.onResponse(0, 404, null, -1, total) as Next.Fail).code)
        assertEquals("forbidden", (DownloadPlan.onResponse(0, 403, null, -1, total) as Next.Fail).code)
        assertEquals("server", (DownloadPlan.onResponse(0, 503, null, -1, total) as Next.Fail).code)
        assertEquals("http", (DownloadPlan.onResponse(0, 418, null, -1, total) as Next.Fail).code)
    }

    @Test
    fun keepsAStorageReserve() {
        val mb = 1024L * 1024
        assertTrue(DownloadPlan.hasRoom(remaining = 1_000 * mb, free = 2_000 * mb))
        assertFalse(DownloadPlan.hasRoom(remaining = 1_000 * mb, free = 1_400 * mb))
        assertTrue(DownloadPlan.hasRoom(remaining = 1_000 * mb, free = 1_400 * mb, reserve = 100 * mb))
    }

    @Test
    fun progressIsThrottledButFirstAndLastAlwaysReport() {
        var now = 0L
        val t = ProgressThrottle(clock = { now }, minIntervalMs = 250)
        assertTrue(t.shouldReport(1, 100))
        now += 100
        assertFalse(t.shouldReport(10, 100))
        now += 200
        assertTrue(t.shouldReport(20, 100))
        now += 1
        assertTrue(t.shouldReport(100, 100))
    }
}
