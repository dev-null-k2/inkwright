package app.inkwright.updates

import android.content.pm.PackageInstaller

/**
 * What a PackageInstaller session's status broadcast means, as the `install` event the web layer
 * gets (`status` and `reason`; plain-language text is chosen in apps/web/src/updates/messages.ts).
 */
object InstallOutcome {
    const val PENDING_USER_ACTION = "pending-user-action"
    const val SUCCESS = "success"
    const val FAILURE = "failure"

    data class Event(val status: String, val reason: String?)

    fun of(status: Int): Event = when (status) {
        PackageInstaller.STATUS_PENDING_USER_ACTION -> Event(PENDING_USER_ACTION, null)
        PackageInstaller.STATUS_SUCCESS -> Event(SUCCESS, null)
        // The person cancelled Android's confirmation (or the session was abandoned).
        PackageInstaller.STATUS_FAILURE_ABORTED -> Event(FAILURE, "aborted")
        // An app with this id but another signing key is installed, or a newer version is.
        PackageInstaller.STATUS_FAILURE_CONFLICT -> Event(FAILURE, "conflict")
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> Event(FAILURE, "incompatible")
        PackageInstaller.STATUS_FAILURE_INVALID -> Event(FAILURE, "invalid")
        PackageInstaller.STATUS_FAILURE_STORAGE -> Event(FAILURE, "storage")
        // A device policy or "Install unknown apps" being off.
        PackageInstaller.STATUS_FAILURE_BLOCKED -> Event(FAILURE, "blocked")
        PackageInstaller.STATUS_FAILURE_TIMEOUT -> Event(FAILURE, "timeout")
        else -> Event(FAILURE, "failure")
    }
}
