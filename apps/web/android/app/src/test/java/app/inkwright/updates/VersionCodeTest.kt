package app.inkwright.updates

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionCodeTest {
    private val fixture = JSONObject(
        VersionCodeTest::class.java.classLoader!!.getResourceAsStream("version-codes.json")!!.bufferedReader().readText(),
    )

    @Test
    fun matchesTheSharedTable() {
        val cases = fixture.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val expected = if (c.isNull("code")) null else c.getLong("code")
            assertEquals(c.getString("version"), expected, VersionCode.of(c.getString("version")))
        }
    }

    @Test
    fun releasesSortInOrderAndFinalsBeatTheirBetas() {
        val ordered = fixture.getJSONArray("ascending").let { a -> (0 until a.length()).map { a.getString(it) } }
        val codes = ordered.map { VersionCode.of(it)!! }
        assertEquals(codes.sorted(), codes)
        assertEquals(codes.size, codes.toSet().size)
        assertTrue(VersionCode.of("0.9.0")!! > VersionCode.of("0.9.0-rc.99")!!)
        assertTrue(VersionCode.of("0.9.0-rc.1")!! > VersionCode.of("0.9.0-beta.99")!!)
    }

    @Test
    fun theNextBetaUpdatesEveryEarlierInstall() {
        // 900 (GitHub betas before the scheme) and 905 (a local beta.5 build).
        assertTrue(VersionCode.of("0.9.0-beta.6")!! > fixture.getLong("legacyHighest"))
    }

    @Test
    fun staysUnderPlaysLimit() {
        assertTrue(VersionCode.of("209.99.99")!! < VersionCode.MAX)
    }

    @Test
    fun parsesStages() {
        assertEquals(VersionCode.Parsed(0, 9, 0, "beta", 6), VersionCode.parse("0.9.0-beta.6"))
        assertEquals(false, VersionCode.parse("1.0.0")!!.isPrerelease)
    }
}
