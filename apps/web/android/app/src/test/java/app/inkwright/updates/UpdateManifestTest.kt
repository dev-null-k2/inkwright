package app.inkwright.updates

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateManifestTest {
    private val repo = "dev-null-k2/inkwright"
    private val pkg = "app.inkwright"
    private val base = "https://github.com/dev-null-k2/inkwright/releases/download/v0.9.0-beta.6"
    private val sha = "a".repeat(64)

    private fun json(edit: JSONObject.() -> Unit = {}) = JSONObject(
        """
        {
          "schema": 1, "app": "app.inkwright", "version": "0.9.0-beta.6", "versionCode": 900206,
          "channel": "beta", "published": "2026-11-04T10:00:00Z", "minSdk": 26, "notes": "- Faster ink",
          "apks": {
            "arm64-v8a": { "url": "$base/Inkwright-0.9.0-beta.6-arm64-v8a.apk", "size": 61234567, "sha256": "$sha" },
            "armeabi-v7a": { "url": "$base/Inkwright-0.9.0-beta.6-armeabi-v7a.apk", "size": 41234567, "sha256": "${"b".repeat(64)}" },
            "x86_64": { "url": "$base/Inkwright-0.9.0-beta.6-x86_64.apk", "size": 71234567, "sha256": "${"C".repeat(64)}" }
          }
        }
        """,
    ).apply(edit).toString()

    private fun parse(text: String) = UpdateManifest.parse(text, pkg, repo)
    private fun apk(o: JSONObject, abi: String = "arm64-v8a") = o.getJSONObject("apks").getJSONObject(abi)

    @Test
    fun readsAValidManifest() {
        val m = parse(json())
        assertEquals("0.9.0-beta.6", m.version)
        assertEquals(900206L, m.versionCode)
        assertEquals("beta", m.channel)
        assertEquals(26, m.minSdk)
        assertEquals("- Faster ink", m.notes)
        assertEquals(3, m.apks.size)
        assertEquals(61234567L, m.apks.getValue("arm64-v8a").size)
        // Checksums are compared in lower case.
        assertEquals("c".repeat(64), m.apks.getValue("x86_64").sha256)
    }

    @Test
    fun picksThePhonesPreferredAbiThenTheNextItRuns() {
        val m = parse(json())
        assertEquals("arm64-v8a", m.apkFor(listOf("arm64-v8a", "armeabi-v7a", "armeabi"))!!.abi)
        assertEquals("x86_64", m.apkFor(listOf("x86_64", "x86", "arm64-v8a"))!!.abi)
        val only32 = parse(json { getJSONObject("apks").remove("arm64-v8a") })
        assertEquals("armeabi-v7a", only32.apkFor(listOf("arm64-v8a", "armeabi-v7a", "armeabi"))!!.abi)
        assertNull(m.apkFor(listOf("x86", "riscv64")))
        assertNull(m.apkFor(emptyList()))
    }

    @Test
    fun refusesAnotherAppOrSchema() {
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("app", "com.example.evil") }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("schema", 2) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse("not json") }
        assertThrows(UpdateManifest.Invalid::class.java) { parse("[]") }
    }

    @Test
    fun refusesVersionCodesThatDoNotFollowTheScheme() {
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("versionCode", 900) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("versionCode", 999999999) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("version", "0.9.0-nightly") }) }
        // A final release must say stable, a pre-release beta.
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("channel", "stable") }) }
        val final = json { put("version", "0.9.0"); put("versionCode", 900900); put("channel", "stable") }
        assertEquals("stable", parse(final).channel)
    }

    @Test
    fun refusesDownloadsFromAnywhereButThisRepositorysReleases() {
        val bad = listOf(
            "http://github.com/dev-null-k2/inkwright/releases/download/v0.9.0-beta.6/x.apk",
            "https://github.com/someone-else/inkwright/releases/download/v0.9.0-beta.6/x.apk",
            "https://github.com.evil.example/dev-null-k2/inkwright/releases/download/v1/x.apk",
            "https://example.com/Inkwright.apk",
            "$base/../../../../evil/x.apk",
            "$base/Inkwright.apk?redirect=https://evil.example",
            "$base/Inkwright.apk#x",
            "$base/Inkwright.zip",
        )
        for (url in bad) {
            assertThrows(url, UpdateManifest.Invalid::class.java) { parse(json { apk(this).put("url", url) }) }
        }
    }

    @Test
    fun refusesMissingOrImplausibleChecksumsAndSizes() {
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { apk(this).put("sha256", "abc") }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { apk(this).remove("sha256") }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { apk(this).put("size", 0) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { apk(this).put("size", UpdateManifest.MAX_APK_BYTES + 1) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { getJSONObject("apks").put("mips", apk(this)) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("apks", JSONObject()) }) }
        assertThrows(UpdateManifest.Invalid::class.java) { parse(json { put("notes", "x".repeat(UpdateManifest.MAX_NOTES_CHARS + 1)) }) }
    }

    @Test
    fun manifestAddressesAreThisRepositorysReleaseAssets() {
        assertTrue(UpdateManifest.isManifestUrl("$base/android-update.json", repo))
        assertFalse(UpdateManifest.isManifestUrl("https://github.com/other/inkwright/releases/download/v1/android-update.json", repo))
        assertFalse(UpdateManifest.isManifestUrl("$base/../x/android-update.json", repo))
        assertFalse(UpdateManifest.isManifestUrl("$base/android-update.json?x=1", repo))
        assertFalse(UpdateManifest.isManifestUrl("$base/latest.json", repo))
    }
}
