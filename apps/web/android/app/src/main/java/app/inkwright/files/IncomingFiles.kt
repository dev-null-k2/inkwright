package app.inkwright.files

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import java.io.File

/**
 * Files other apps hand to Inkwright: "Open with Inkwright" (ACTION_VIEW) and the share sheet
 * (ACTION_SEND / ACTION_SEND_MULTIPLE, including shared plain text). Each file is copied into the
 * app's cache so the web layer can read it with Capacitor Filesystem (the content:// grant only
 * lasts while the intent does), and the web layer deletes the copy once it has imported it.
 */
object IncomingFiles {
    data class Incoming(val name: String, val mimeType: String, val path: String)

    private const val TAG = "InkwrightFiles"
    private const val DIR = "incoming"

    /** Whether this intent carries files (or text) for Inkwright. */
    fun isIncoming(intent: Intent?): Boolean = when (intent?.action) {
        // inkwright:// deep links are VIEW intents too; Capacitor's App plugin hands those to the
        // web layer (appUrlOpen), so only content:// data are files.
        Intent.ACTION_VIEW -> intent.data?.scheme == "content"
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> true
        else -> false
    }

    /** Copies everything the intent carries into the cache. Call off the main thread. */
    fun copyAll(context: Context, intent: Intent): List<Incoming> {
        val dir = File(context.cacheDir, DIR).apply { mkdirs() }
        val out = ArrayList<Incoming>()
        for (uri in uris(intent)) {
            try {
                out += copy(context, uri, dir, intent.type)
            } catch (e: Exception) {
                Log.w(TAG, "Could not read $uri", e)
            }
        }
        // Shared text (a link, a passage) without a file becomes a text note.
        if (out.isEmpty() && intent.action == Intent.ACTION_SEND) {
            val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
                .filter { it.isNotBlank() }
                .joinToString("\n")
            if (text.isNotBlank()) {
                val f = uniqueFile(dir, "Shared text.txt")
                f.writeText(text)
                out += Incoming(f.name, "text/plain", Uri.fromFile(f).toString())
            }
        }
        return out
    }

    private fun uris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_VIEW -> listOfNotNull(intent.data)
        Intent.ACTION_SEND -> listOfNotNull(stream(intent))
        Intent.ACTION_SEND_MULTIPLE -> streams(intent)
        else -> emptyList()
    }

    @Suppress("DEPRECATION")
    private fun stream(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()

    private fun copy(context: Context, uri: Uri, dir: File, fallbackType: String?): Incoming {
        // Only content:// URIs, which the sending app grants. A file:// URI is read with
        // Inkwright's own rights, so any app could name a file in Inkwright's private storage
        // (the WebView's IndexedDB with the vault and keys) and have it imported as a note; and our
        // own FileProvider is not a source either (security review SR-11).
        require(uri.scheme == "content") { "Only content:// URIs are accepted" }
        require(uri.authority != "${context.packageName}.fileprovider") { "Inkwright's own files are not a share source" }
        val resolver = context.contentResolver
        val mime = resolver.getType(uri) ?: fallbackType ?: "application/octet-stream"
        val name = displayName(context, uri) ?: "Shared file"
        val target = uniqueFile(dir, name)
        val input = resolver.openInputStream(uri)
        requireNotNull(input) { "No data" }.use { src -> target.outputStream().use { dst -> src.copyTo(dst) } }
        return Incoming(target.name, mime, Uri.fromFile(target).toString())
    }

    private fun displayName(context: Context, uri: Uri): String? {
        return try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (e: Exception) {
            null
        } ?: uri.lastPathSegment
    }

    /** A cache file with a safe name that doesn't overwrite one still waiting to be imported. */
    private fun uniqueFile(dir: File, name: String): File {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]+"), "-").take(120).ifBlank { "file" }
        var f = File(dir, safe)
        var n = 1
        val dot = safe.lastIndexOf('.')
        while (f.exists()) {
            f = File(dir, if (dot > 0) "${safe.substring(0, dot)} ($n)${safe.substring(dot)}" else "$safe ($n)")
            n++
        }
        return f
    }
}
