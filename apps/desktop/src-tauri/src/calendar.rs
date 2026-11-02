//! Fetches a calendar subscription (an `.ics` address, e.g. Google Calendar's "secret address in
//! iCal format") for the journal. Done here rather than in the web view because calendar servers
//! don't send CORS headers. Only `https:` (and `webcal:`, which means https) addresses are
//! fetched, the answer must be an iCalendar file, and it is capped at 10 MB. The address itself
//! is a secret (anyone with it can read the calendar): the web app keeps it in the device's
//! encrypted secret store, and nothing here logs it.

use std::time::Duration;

pub const MAX_BYTES: usize = 10 * 1024 * 1024;

/// Normalises and checks a subscription address. `webcal://` becomes `https://`.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let url = if lower.starts_with("webcal://") || lower.starts_with("webcals://") {
        format!("https://{}", &raw[raw.find("://").unwrap() + 3..])
    } else {
        raw.to_string()
    };
    let parsed = reqwest::Url::parse(&url).map_err(|_| "That is not a web address".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Calendar addresses must start with https:// or webcal://".into());
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("That address has no host".into());
    }
    Ok(parsed.to_string())
}

/// True when the text looks like an iCalendar file.
pub fn looks_like_icalendar(text: &str) -> bool {
    text.trim_start_matches('\u{feff}').trim_start().to_ascii_uppercase().starts_with("BEGIN:VCALENDAR")
}

pub async fn fetch(raw: &str) -> Result<String, String> {
    let url = normalize_url(raw)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(concat!("Inkwright/", env!("CARGO_PKG_VERSION"), " (calendar import)"))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(&url).send().await.map_err(|e| format!("Couldn't reach the calendar: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("The calendar server answered {}", res.status()));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Err("That calendar is larger than 10 MB".into());
        }
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !looks_like_icalendar(&text) {
        return Err("That address did not return a calendar (.ics) file".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_webcal_only() {
        assert_eq!(normalize_url("webcal://p01-calendars.icloud.com/published/2/abc").unwrap(), "https://p01-calendars.icloud.com/published/2/abc");
        assert_eq!(normalize_url(" https://calendar.google.com/calendar/ical/x/basic.ics ").unwrap(), "https://calendar.google.com/calendar/ical/x/basic.ics");
        assert!(normalize_url("http://example.com/cal.ics").is_err());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("calendar").is_err());
    }

    #[test]
    fn recognises_icalendar() {
        assert!(looks_like_icalendar("\u{feff}BEGIN:VCALENDAR\r\nVERSION:2.0"));
        assert!(looks_like_icalendar("  begin:vcalendar"));
        assert!(!looks_like_icalendar("<html>sign in</html>"));
    }
}
