package app.inkwright.updates

import android.os.StatFs
import app.inkwright.ai.DownloadPlan
import app.inkwright.ai.ProgressThrottle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** A failure the web layer explains by [code] (apps/web/src/updates/messages.ts). */
class UpdateException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Downloads release files from GitHub over HTTPS: the small manifest, and the APK into [dir]
 * (resumably, with the same [DownloadPlan] as on-device AI models), then checks the APK's SHA-256.
 *
 * GitHub answers release downloads with a redirect to its download host;
 * HttpURLConnection follows it only to another HTTPS address (never down to HTTP), and the final
 * address is checked to still be HTTPS. Cancelling the calling coroutine stops within one buffer
 * and keeps the part file for the next attempt.
 */
class ApkDownloader(private val dir: File, private val userAgent: String) {
    fun interface Progress {
        /** [phase] is `download` or `verify`. */
        fun onProgress(phase: String, loaded: Long, total: Long)
    }

    /** The whole body of a small file (at most [maxBytes]) as text. */
    suspend fun fetchText(url: String, maxBytes: Int): String = withContext(Dispatchers.IO) {
        val conn = open(url, 0)
        try {
            when (val code = conn.responseCode) {
                200 -> Unit
                404, 410 -> throw UpdateException("gone", "The release has no update description (HTTP $code).")
                else -> throw UpdateException("http", "Release download failed (HTTP $code).")
            }
            checkStillHttps(conn)
            val out = ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val buf = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (out.size() + n > maxBytes) throw UpdateException("invalid", "The update description is too large.")
                    out.write(buf, 0, n)
                }
            }
            out.toString(Charsets.UTF_8.name())
        } catch (e: IOException) {
            throw UpdateException("network", "Couldn’t reach GitHub.", e)
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Downloads [apk] to `dir/<name>.part`, verifies its SHA-256 and renames it to [name].
     * Returns the verified file. A verified file already there (an earlier download) is returned
     * after its checksum is checked again.
     */
    suspend fun download(apk: UpdateManifest.Apk, name: String, progress: Progress): File = withContext(Dispatchers.IO) {
        dir.mkdirs()
        val done = File(dir, name)
        if (done.isFile && done.length() == apk.size) {
            if (sha256(done, apk.size, progress) == apk.sha256) return@withContext done
            done.delete()
        }
        val part = File(dir, "$name.part")
        var attempts = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            val have = if (part.isFile) part.length() else 0L
            val plan = DownloadPlan.start(have, apk.size)
            if (plan is DownloadPlan.Start.Complete) break
            val from = (plan as? DownloadPlan.Start.Resume)?.from ?: 0L
            if (from == 0L) part.delete()
            // The APK, then the installer's copy of it: twice its size, plus the usual reserve.
            if (!DownloadPlan.hasRoom(2 * (apk.size - from), StatFs(dir.path).availableBytes, reserve = 64L * 1024 * 1024)) {
                throw UpdateException("storage", "Not enough free storage for the update.")
            }
            val failure: Throwable? = try {
                if (fetch(apk, part, from, progress)) break
                null
            } catch (e: IOException) {
                e
            }
            if (++attempts >= MAX_ATTEMPTS) throw UpdateException("network", "The download stopped.", failure)
        }
        val hash = sha256(part, apk.size, progress)
        if (hash != apk.sha256) {
            part.delete()
            throw UpdateException("checksum", "The downloaded file does not match the release’s checksum.")
        }
        if (!part.renameTo(done)) throw UpdateException("storage", "Couldn’t save the update.")
        done
    }

    private fun open(url: String, from: Long): HttpURLConnection {
        if (!url.startsWith("https://")) throw UpdateException("invalid", "Updates are only downloaded over HTTPS.")
        return (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", userAgent)
            if (from > 0) setRequestProperty("Range", DownloadPlan.rangeHeader(from))
        }
    }

    private fun checkStillHttps(conn: HttpURLConnection) {
        if (conn.url.protocol != "https") throw UpdateException("invalid", "The download was redirected away from HTTPS.")
    }

    /** One HTTP request. True when the part file is complete afterwards. */
    private suspend fun fetch(apk: UpdateManifest.Apk, part: File, from: Long, progress: Progress): Boolean {
        val conn = open(apk.url, from)
        try {
            val next = DownloadPlan.onResponse(from, conn.responseCode, conn.getHeaderField("Content-Range"), conn.contentLengthLong, apk.size)
            checkStillHttps(conn)
            val offset = when (next) {
                is DownloadPlan.Next.Done -> return true
                // The plan's codes: changed, gone, forbidden, server, http, bad-response.
                is DownloadPlan.Next.Fail -> throw UpdateException(next.code, "Release download failed (${conn.responseCode}).")
                is DownloadPlan.Next.Append -> next.from
                DownloadPlan.Next.Restart -> 0L
            }
            val throttle = ProgressThrottle()
            var loaded = offset
            conn.inputStream.use { input ->
                FileOutputStream(part, offset > 0).use { out ->
                    if (offset == 0L) out.channel.truncate(0)
                    val buf = ByteArray(BUFFER)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        if (loaded + n > apk.size) throw UpdateException("changed", "The file on GitHub is larger than the release says.")
                        out.write(buf, 0, n)
                        loaded += n
                        if (throttle.shouldReport(loaded, apk.size)) progress.onProgress("download", loaded, apk.size)
                    }
                }
            }
            return loaded == apk.size
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun sha256(file: File, total: Long, progress: Progress): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val throttle = ProgressThrottle()
        var read = 0L
        FileInputStream(file).use { input ->
            val buf = ByteArray(BUFFER)
            while (true) {
                currentCoroutineContext().ensureActive()
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
                read += n
                if (throttle.shouldReport(read, total)) progress.onProgress("verify", read, total)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val BUFFER = 256 * 1024
        const val MAX_ATTEMPTS = 4
    }
}
