package app.inkwright.updates

import android.content.pm.PackageInstaller
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignerCheckTest {
    private val ours = SignerCheck.digest("inkwright upload key".toByteArray())
    private val other = SignerCheck.digest("someone else".toByteArray())
    private val rotated = SignerCheck.digest("inkwright key after rotation".toByteArray())

    @Test
    fun digestIsSha256Hex() {
        // SHA-256("abc"), the FIPS 180-2 test vector.
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", SignerCheck.digest("abc".toByteArray()))
    }

    @Test
    fun acceptsTheSameKey() {
        assertTrue(SignerCheck.accepts(SignerCheck.Signers(setOf(ours)), SignerCheck.Signers(setOf(ours))))
    }

    @Test
    fun refusesAnotherKey() {
        assertFalse(SignerCheck.accepts(SignerCheck.Signers(setOf(ours)), SignerCheck.Signers(setOf(other))))
        // An attacker can't list our certificate as "history" of theirs without the lineage being
        // signed by our key, which Android verifies; but our check alone must not accept a
        // multi-signer APK that merely contains our key either.
        assertFalse(SignerCheck.accepts(SignerCheck.Signers(setOf(ours)), SignerCheck.Signers(setOf(ours, other))))
    }

    @Test
    fun acceptsARotatedKeyWhoseLineageStartsAtOurs() {
        assertTrue(SignerCheck.accepts(SignerCheck.Signers(setOf(ours)), SignerCheck.Signers(setOf(rotated), listOf(ours, rotated))))
        assertFalse(SignerCheck.accepts(SignerCheck.Signers(setOf(ours)), SignerCheck.Signers(setOf(rotated), listOf(other, rotated))))
    }

    @Test
    fun refusesUnsignedOrUnreadable() {
        assertFalse(SignerCheck.accepts(SignerCheck.Signers(setOf(ours)), SignerCheck.Signers(emptySet(), emptyList())))
        assertFalse(SignerCheck.accepts(SignerCheck.Signers(emptySet(), emptyList()), SignerCheck.Signers(emptySet(), emptyList())))
    }
}

class UpdateFilesTest {
    @Test
    fun namesCarryVersionAndAbi() {
        assertEquals("Inkwright-900206-arm64-v8a.apk", UpdateFiles.verified(900206, "arm64-v8a"))
        assertEquals("Inkwright-900206-arm64-v8a.apk.part", UpdateFiles.partial(900206, "arm64-v8a"))
        assertEquals(900206L, UpdateFiles.versionCodeOf("Inkwright-900206-arm64-v8a.apk"))
        assertNull(UpdateFiles.versionCodeOf("notes.txt"))
    }

    @Test
    fun deletesWhatIsInstalledOrForeignAndKeepsNewerDownloads() {
        val installed = 900206L
        assertTrue(UpdateFiles.isStale("Inkwright-900206-arm64-v8a.apk", installed))
        assertTrue(UpdateFiles.isStale("Inkwright-900205-arm64-v8a.apk.part", installed))
        assertTrue(UpdateFiles.isStale("something-else.bin", installed))
        assertFalse(UpdateFiles.isStale("Inkwright-900207-arm64-v8a.apk", installed))
        assertFalse(UpdateFiles.isStale("Inkwright-900900-arm64-v8a.apk.part", installed))
    }
}

class InstallOutcomeTest {
    @Test
    fun mapsSessionStatuses() {
        assertEquals(InstallOutcome.Event("pending-user-action", null), InstallOutcome.of(PackageInstaller.STATUS_PENDING_USER_ACTION))
        assertEquals(InstallOutcome.Event("success", null), InstallOutcome.of(PackageInstaller.STATUS_SUCCESS))
        assertEquals("aborted", InstallOutcome.of(PackageInstaller.STATUS_FAILURE_ABORTED).reason)
        assertEquals("conflict", InstallOutcome.of(PackageInstaller.STATUS_FAILURE_CONFLICT).reason)
        assertEquals("blocked", InstallOutcome.of(PackageInstaller.STATUS_FAILURE_BLOCKED).reason)
        assertEquals("storage", InstallOutcome.of(PackageInstaller.STATUS_FAILURE_STORAGE).reason)
        assertEquals("failure", InstallOutcome.of(12345).reason)
    }
}
