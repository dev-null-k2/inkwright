package app.inkwright.calendar

import android.content.Intent
import android.provider.CalendarContract

/**
 * "Circle a date and it goes to your calendar": builds the standard ACTION_INSERT intent so the
 * user's own calendar app opens a prefilled new event they confirm themselves. Inkwright never
 * reads or writes the calendar directly, so it needs no calendar permission.
 */
object CalendarIntents {
    data class Event(
        val title: String,
        val beginMs: Long,
        val endMs: Long,
        val allDay: Boolean,
        val description: String?,
        val location: String?,
    )

    fun insert(e: Event): Intent = Intent(Intent.ACTION_INSERT).apply {
        data = CalendarContract.Events.CONTENT_URI
        putExtra(CalendarContract.Events.TITLE, e.title)
        putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, e.beginMs)
        putExtra(CalendarContract.EXTRA_EVENT_END_TIME, maxOf(e.endMs, e.beginMs))
        putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, e.allDay)
        e.description?.takeIf { it.isNotBlank() }?.let { putExtra(CalendarContract.Events.DESCRIPTION, it) }
        e.location?.takeIf { it.isNotBlank() }?.let { putExtra(CalendarContract.Events.EVENT_LOCATION, it) }
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
