//! Sends meeting notes and action items to other tools (Slack, Notion, Linear, Jira, GitHub,
//! Todoist, HubSpot, Attio, Salesforce, Teams, webhooks) for the web app, because most of those
//! APIs don't answer requests from a web view (no CORS headers). Only `https:` to public hosts,
//! at most 1 MB each way, 25 s. Tokens arrive in the headers of each call from the device's
//! secret store and are never logged or kept here.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(serde::Deserialize)]
pub struct Request {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(serde::Serialize)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Checks the address: https, a host name or public address (never this computer or the LAN).
pub fn check_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "That is not a web address".to_string())?;
    if url.scheme() != "https" {
        return Err("Only https:// addresses can be used".into());
    }
    let host = url.host_str().unwrap_or("").trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return Err("That address is on this computer or network".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let private = match ip {
            IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.octets()[0] == 100 && (64..128).contains(&v.octets()[1]),
            IpAddr::V6(v) => v.is_loopback() || v.is_unspecified() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
        };
        if private {
            return Err("That address is on this computer or network".into());
        }
    }
    Ok(url)
}

const ALLOWED_HEADERS: &[&str] = &["authorization", "content-type", "accept", "notion-version", "linear-client", "x-github-api-version", "user-agent"];

pub async fn send(req: Request) -> Result<Response, String> {
    let url = check_url(&req.url)?;
    let method = match req.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "PUT" => reqwest::Method::PUT,
        _ => return Err("Unsupported method".into()),
    };
    if req.body.as_ref().map(|b| b.len()).unwrap_or(0) > MAX_BYTES {
        return Err("That is more than 1 MB to send".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(concat!("Inkwright/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut rb = client.request(method, url);
    for (k, v) in &req.headers {
        if ALLOWED_HEADERS.contains(&k.to_ascii_lowercase().as_str()) {
            rb = rb.header(k.as_str(), v.as_str());
        }
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let mut res = rb.send().await.map_err(|e| format!("Couldn't reach the service: {}", e.without_url()))?;
    let status = res.status().as_u16();
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            break;
        }
    }
    body.truncate(MAX_BYTES);
    Ok(Response { status, body: String::from_utf8_lossy(&body).into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_https_only() {
        assert!(check_url("https://hooks.slack.com/services/T/B/x").is_ok());
        assert!(check_url("https://api.notion.com/v1/pages").is_ok());
        assert!(check_url("http://hooks.slack.com/x").is_err());
        assert!(check_url("https://localhost:8080/x").is_err());
        assert!(check_url("https://127.0.0.1/x").is_err());
        assert!(check_url("https://192.168.1.5/x").is_err());
        assert!(check_url("https://10.0.0.1/x").is_err());
        assert!(check_url("https://[::1]/x").is_err());
        assert!(check_url("https://printer.local/x").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("https://8.8.8.8/x").is_ok());
    }
}
