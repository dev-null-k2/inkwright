package app.inkstone.ai

import android.os.StatFs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Downloads a pinned model file into [dir], resumably (see [DownloadPlan]), then checks its
 * SHA-256 before it is used. Runs on [Dispatchers.IO]; cancelling the calling coroutine stops the
 * transfer within one buffer and keeps the part file for the next attempt.
 *
 * Plain HttpURLConnection on purpose: it follows Hugging Face's redirect to its CDN, honours the
 * system proxy, and adds no dependency.
 */
class ModelDownloader(private val dir: File) {
    fun interface Progress {
        /** [phase] is `download` or `verify`. */
        fun onProgress(phase: String, loaded: Long, total: Long)
    }

    fun fileFor(model: LiteRtModel) = File(dir, model.file)
    private fun partFor(model: LiteRtModel) = File(dir, model.file + ".part")
    private fun okFor(model: LiteRtModel) = File(dir, model.file + ".ok")

    /** On disk, complete and verified (the `.ok` marker is written only after the hash matched). */
    fun isInstalled(model: LiteRtModel): Boolean {
        val f = fileFor(model)
        return f.isFile && f.length() == model.bytes && okFor(model).isFile
    }

    /** Bytes of an interrupted download that the next attempt resumes from. */
    fun partialBytes(model: LiteRtModel): Long = partFor(model).takeIf { it.isFile }?.length() ?: 0L

    fun delete(model: LiteRtModel) {
        okFor(model).delete()
        fileFor(model).delete()
        partFor(model).delete()
    }

    suspend fun download(model: LiteRtModel, progress: Progress) = withContext(Dispatchers.IO) {
        if (isInstalled(model)) return@withContext
        dir.mkdirs()
        val part = partFor(model)
        var attempts = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            val have = if (part.isFile) part.length() else 0L
            val plan = DownloadPlan.start(have, model.bytes)
            if (plan is DownloadPlan.Start.Complete) break
            val from = (plan as? DownloadPlan.Start.Resume)?.from ?: 0L
            if (from == 0L) part.delete()
            if (!DownloadPlan.hasRoom(model.bytes - from, StatFs(dir.path).availableBytes)) {
                throw AiException("disk", "Not enough free storage: ${model.label} needs ${gb(model.bytes - from)} more.")
            }
            // Network drops mid-transfer (an exception, or a body that ends early): retry from what
            // arrived, a few times, then give up — the part file stays, so Download resumes.
            val failure: Throwable? = try {
                if (fetch(model, part, from, progress)) break
                null
            } catch (e: IOException) {
                e
            }
            if (++attempts >= MAX_ATTEMPTS) throw AiException("network", "The download stopped. Check the connection and tap Download to resume.", retryable = true, cause = failure)
        }
        verify(model, part, progress)
        if (!part.renameTo(fileFor(model))) throw AiException("disk", "Couldn’t save the model file.")
        okFor(model).writeText(model.sha256)
    }

    /** One HTTP request. True when the part file is complete afterwards. */
    private suspend fun fetch(model: LiteRtModel, part: File, from: Long, progress: Progress): Boolean {
        val conn = (URL(model.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "Inkstone-Android")
            if (from > 0) setRequestProperty("Range", DownloadPlan.rangeHeader(from))
        }
        try {
            val next = DownloadPlan.onResponse(from, conn.responseCode, conn.getHeaderField("Content-Range"), conn.contentLengthLong, model.bytes)
            val offset = when (next) {
                is DownloadPlan.Next.Done -> return true
                is DownloadPlan.Next.Fail -> throw AiException(next.code, next.message)
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
                        if (loaded + n > model.bytes) throw AiException("changed", "The model file on the server isn’t the expected one.")
                        out.write(buf, 0, n)
                        loaded += n
                        if (throttle.shouldReport(loaded, model.bytes)) progress.onProgress("download", loaded, model.bytes)
                    }
                }
            }
            return loaded == model.bytes
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun verify(model: LiteRtModel, part: File, progress: Progress) {
        val digest = MessageDigest.getInstance("SHA-256")
        val throttle = ProgressThrottle()
        var read = 0L
        FileInputStream(part).use { input ->
            val buf = ByteArray(BUFFER)
            while (true) {
                currentCoroutineContext().ensureActive()
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
                read += n
                if (throttle.shouldReport(read, model.bytes)) progress.onProgress("verify", read, model.bytes)
            }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        if (!hex.equals(model.sha256, ignoreCase = true)) {
            part.delete()
            throw AiException("corrupt", "The downloaded model was damaged. Tap Download to try again.")
        }
    }

    private fun gb(bytes: Long) = "%.1f GB".format(bytes / 1e9)

    private companion object {
        const val BUFFER = 256 * 1024
        const val MAX_ATTEMPTS = 4
    }
}
