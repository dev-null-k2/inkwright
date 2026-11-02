package app.inkwright.ai

import android.content.Context
import android.graphics.Bitmap
import com.google.common.util.concurrent.ListenableFuture
import com.google.mlkit.genai.common.DownloadCallback
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.common.StreamingCallback
import com.google.mlkit.genai.imagedescription.ImageDescriberOptions
import com.google.mlkit.genai.imagedescription.ImageDescription
import com.google.mlkit.genai.imagedescription.ImageDescriptionRequest
import com.google.mlkit.genai.proofreading.ProofreaderOptions
import com.google.mlkit.genai.proofreading.Proofreading
import com.google.mlkit.genai.proofreading.ProofreadingRequest
import com.google.mlkit.genai.rewriting.RewriterOptions
import com.google.mlkit.genai.rewriting.Rewriting
import com.google.mlkit.genai.rewriting.RewritingRequest
import com.google.mlkit.genai.summarization.Summarization
import com.google.mlkit.genai.summarization.SummarizationRequest
import com.google.mlkit.genai.summarization.SummarizerOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * The ML Kit GenAI task APIs — summarization, proofreading, rewriting, image description. They run
 * Gemini Nano with a task-tuned adapter, so on AICore phones they beat a general prompt for these
 * jobs; each feature is downloaded by AICore separately (a few MB of adapter on top of the shared
 * model). Clients are created per call with the options the call needs and closed afterwards.
 */
class GenAiTasks(private val context: Context) {
    /** Options for one call. [tone] only for rewrite, [style] only for summarize. */
    data class Request(val task: GenAiTask, val language: String?, val text: String = "", val image: Bitmap? = null, val style: String? = null, val tone: String? = null, val inputKind: String? = null)

    private sealed interface Client {
        fun status(): ListenableFuture<Int>
        fun download(cb: DownloadCallback): ListenableFuture<Void>
        fun close()
    }

    private class Summ(val c: com.google.mlkit.genai.summarization.Summarizer) : Client {
        override fun status() = c.checkFeatureStatus()
        override fun download(cb: DownloadCallback) = c.downloadFeature(cb)
        override fun close() = c.close()
    }

    private class Proof(val c: com.google.mlkit.genai.proofreading.Proofreader) : Client {
        override fun status() = c.checkFeatureStatus()
        override fun download(cb: DownloadCallback) = c.downloadFeature(cb)
        override fun close() = c.close()
    }

    private class Rew(val c: com.google.mlkit.genai.rewriting.Rewriter) : Client {
        override fun status() = c.checkFeatureStatus()
        override fun download(cb: DownloadCallback) = c.downloadFeature(cb)
        override fun close() = c.close()
    }

    private class Desc(val c: com.google.mlkit.genai.imagedescription.ImageDescriber) : Client {
        override fun status() = c.checkFeatureStatus()
        override fun download(cb: DownloadCallback) = c.downloadFeature(cb)
        override fun close() = c.close()
    }

    /** A client for [r], or null when the task doesn't support the language (the caller falls back). */
    private fun client(r: Request): Client? {
        val lang = TaskOptions.language(r.task, r.language) ?: return null
        val ctx = context.applicationContext
        return when (r.task) {
            GenAiTask.SUMMARIZE -> Summ(Summarization.getClient(
                SummarizerOptions.builder(ctx).setInputType(TaskOptions.SUMMARY_INPUT_ARTICLE).setOutputType(TaskOptions.summaryOutput(r.style))
                    .setLanguage(lang).setLongInputAutoTruncationEnabled(true).build(),
            ))
            GenAiTask.PROOFREAD -> Proof(Proofreading.getClient(
                ProofreaderOptions.builder(ctx).setInputType(TaskOptions.proofreadInput(r.inputKind)).setLanguage(lang).build(),
            ))
            GenAiTask.REWRITE -> Rew(Rewriting.getClient(
                RewriterOptions.builder(ctx).setOutputType(TaskOptions.rewriteOutput(r.tone) ?: TaskOptions.REWRITE_REPHRASE).setLanguage(lang).build(),
            ))
            GenAiTask.DESCRIBE_IMAGE -> Desc(ImageDescription.getClient(ImageDescriberOptions.builder(ctx).build()))
        }
    }

    suspend fun state(task: GenAiTask, language: String?): EngineState = withContext(Dispatchers.IO) {
        val c = client(Request(task, language)) ?: return@withContext EngineState.UNAVAILABLE
        try {
            EngineState.fromFeatureStatus(c.status().await())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            EngineState.UNAVAILABLE
        } finally {
            c.close()
        }
    }

    /** Downloads the task's feature, reporting bytes; returns when it is ready. */
    suspend fun download(task: GenAiTask, language: String?, onProgress: (loaded: Long, total: Long) -> Unit) = withContext(Dispatchers.IO) {
        val c = client(Request(task, language)) ?: throw AiException("unsupported", "This isn’t available in your language on this phone yet.")
        try {
            var total = 0L
            val err = suspendCancellableCoroutine { cont ->
                val f = c.download(object : DownloadCallback {
                    override fun onDownloadStarted(bytesToDownload: Long) { total = bytesToDownload; onProgress(0, total) }
                    override fun onDownloadProgress(totalBytesDownloaded: Long) = onProgress(totalBytesDownloaded, total)
                    override fun onDownloadCompleted() { if (cont.isActive) cont.resume(null) }
                    override fun onDownloadFailed(e: GenAiException) { if (cont.isActive) cont.resume(GenAiErrors.describe(e.errorCode, e.message, e)) }
                })
                cont.invokeOnCancellation { f.cancel(true) }
            }
            if (err != null) throw err
        } finally {
            c.close()
        }
    }

    /** Runs [r], streaming text into [out] where the API streams. Returns the result text. */
    suspend fun run(r: Request, out: StreamAssembler): String = withContext(Dispatchers.IO) {
        val c = client(r) ?: throw AiException("unsupported", "This isn’t available in your language on this phone yet.")
        val stream = StreamingCallback { t -> synchronized(out) { out.push(t) } }
        try {
            val text = when (c) {
                is Summ -> c.c.runInference(SummarizationRequest.builder(r.text).build(), stream).await().summary
                is Proof -> c.c.runInference(ProofreadingRequest.builder(r.text).build(), stream).await().results.firstOrNull()?.text
                is Rew -> c.c.runInference(RewritingRequest.builder(r.text).build(), stream).await().results.firstOrNull()?.text
                is Desc -> {
                    val bmp = r.image ?: throw AiException("bad-request", "No image to describe.")
                    c.c.runInference(ImageDescriptionRequest.builder(bmp).build(), stream).await().description
                }
            }
            synchronized(out) { out.finish(text) }
        } catch (e: GenAiException) {
            throw GenAiErrors.describe(e.errorCode, e.message, e)
        } finally {
            c.close()
        }
    }
}
