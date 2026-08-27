//! Desktop (Tauri) Google OAuth — "Grant type: Authorization Code + PKCE"
//! using the system browser, because the installed app's origin
//! (`http://tauri.localhost`) cannot be registered as an *Authorized JavaScript
//! origin* for Google's inline GIS flow.
//!
//! Flow:
//!   1. `google_oauth_start(client_id, scope)` generates a PKCE `code_verifier`
//!      + S256 `code_challenge` and a CSRF `state`, starts a tiny loopback HTTP
//!      server on a fixed port (`127.0.0.1:8543/oauth_callback`), opens the
//!      system browser at Google's authorization endpoint, and returns the URL.
//!   2. The front-end polls `google_oauth_poll(client_id)`. When the browser
//!      returns, the loopback server captures `?code=...&state=...` (validating
//!      `state`), stores the code, and exchanges it for an `access_token`
//!      (public client → no client_secret needed). The token is returned.
//!   3. `google_oauth_clear()` discards the code/token.
//!
//! The exchanged access token is handed to the front-end Drive layer
//! (`googleDriveSync`) which performs the actual appDataFolder read/write.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};

/// Fixed loopback port for the OAuth callback (must match the Google
/// "Authorized redirect URIs" entry `http://127.0.0.1:8543/oauth_callback`).
pub const OAUTH_PORT: u16 = 8543;
pub const OAUTH_REDIRECT: &str = "http://127.0.0.1:8543/oauth_callback";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// Shared per-launch OAuth state (code + verifier captured across threads).
struct OAuthShared {
    /// Stored when the loopback server receives `?code=...`.
    code: Mutex<Option<String>>,
    /// The PKCE `code_verifier` for this flow (kept to exchange the code).
    verifier: Mutex<Option<String>>,
    /// The expected CSRF `state` for this flow.
    state_expected: Mutex<Option<String>>,
}

static OAUTH: OnceLock<OAuthShared> = OnceLock::new();

fn shared() -> &'static OAuthShared {
    OAUTH.get_or_init(|| OAuthShared {
        code: Mutex::new(None),
        verifier: Mutex::new(None),
        state_expected: Mutex::new(None),
    })
}

/// Random URL-safe string of `n` bytes (base64url, no padding).
fn random_token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

/// base64url(SHA-256(verifier)) — the PKCE S256 code challenge.
fn s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Tiny loopback HTTP server: reads the request, extracts `code`/`state` from
/// `/oauth_callback?code=...&state=...`, stores the code, replies with HTML.
fn serve_callback(listener: TcpListener, expected_state: String) {
    let sh = shared();
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut buf = vec![0u8; 4096];
        let n = match stream.read(&mut buf) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]).to_string();
        let first_line = request.lines().next().unwrap_or("").to_string();
        // e.g. GET /oauth_callback?code=...state=... HTTP/1.1
        let query = first_line
            .split(' ')
            .nth(1)
            .unwrap_or("")
            .to_string();
        let code = extract_param(&query, "code");
        let state = extract_param(&query, "state");
        let body = if let Some(c) = code {
            if state.as_deref() == Some(&expected_state) {
                *sh.code.lock().unwrap() = Some(c.clone());
                "<html><body><h3 style='font-family:sans-serif'>Authorized ✓</h3><p>You can close this tab and return to NeedMusic.</p></body></html>"
                    .to_string()
            } else {
                "<html><body><h3>State mismatch — authorization failed.</h3></body></html>".to_string()
            }
        } else {
            "<html><body><h3>Missing authorization code.</h3></body></html>".to_string()
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        break; // single callback is enough
    }
}

/// Parse `?name=value&...` from a URL path+query string.
fn extract_param(query: &str, name: &str) -> Option<String> {
    let start = query.find('?')?;
    let qs = &query[start + 1..];
    for part in qs.split('&') {
        let mut it = part.splitn(2, '=');
        let key = it.next()?;
        if key == name {
            return Some(it.next().unwrap_or("").to_string());
        }
    }
    None
}

/// Exchange an authorization `code` for an access token, using the client id +
/// client_secret (Google requires a secret for this client even with PKCE).
/// Uses the ASYNC reqwest client: Tauri commands run in tokio's async context,
/// and a *blocking* call there panics with
/// "Cannot drop a runtime in a context where blocking is not allowed".
async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    verifier: &str,
    code: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut params: Vec<(&str, &str)> = vec![
        ("code", code),
        ("client_id", client_id),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier),
    ];
    // Include the redirect_uri as declared for the loopback callback.
    params.push(("redirect_uri", OAUTH_REDIRECT));
    // Only send client_secret if a non-empty one was provided.
    if !client_secret.is_empty() {
        params.push(("client_secret", client_secret));
    }
    let resp = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("token parse failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "token exchange HTTP {}: {}",
            status,
            json.get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error")
        ));
    }
    json.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no access_token in response".to_string())
}

/// Tauri command — start the system-browser OAuth flow and return the
/// authorization URL (also opens the browser automatically).
#[tauri::command]
pub async fn google_oauth_start(client_id: String, scope: String) -> Result<String, String> {
    let verifier = random_token(48);
    let challenge = s256_challenge(&verifier);
    let state = random_token(24);

    {
        let sh = shared();
        *sh.verifier.lock().unwrap() = Some(verifier.clone());
        *sh.state_expected.lock().unwrap() = Some(state.clone());
        *sh.code.lock().unwrap() = None;
    }

    // Start the loopback callback server on a background thread. It writes the
    // received code into the shared state that `google_oauth_poll` reads.
    let listener = TcpListener::bind(format!("127.0.0.1:{OAUTH_PORT}"))
        .map_err(|e| format!("could not bind loopback OAuth port {OAUTH_PORT}: {e}"))?;
    let expected = state.clone();
    std::thread::spawn(move || serve_callback(listener, expected));

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&prompt=consent",
        percent_encode(&client_id),
        percent_encode(OAUTH_REDIRECT),
        percent_encode(&scope),
        percent_encode(&challenge),
        percent_encode(&state),
    );

    Ok(auth_url)
    // Note: the auth URL is returned to the front-end, which opens it with the
    // Tauri shell plugin (open<url>). Doing it in Rust is fragile on Windows
    // (cmd splits on `&`; explorer opens a folder for some builds), so the
    // front-end's shell::open is the reliable path and keeps `&` intact.
}

/// Tauri command — poll for the OAuth result (non-blocking). Returns the
/// access token once the browser returned and it was exchanged, else empty.
#[tauri::command]
pub async fn google_oauth_poll(client_id: String, client_secret: String) -> Result<String, String> {
    let sh = shared();
    let code = sh.code.lock().unwrap().clone();
    eprintln!("[oauth] poll: code_present={}", code.is_some());
    if let Some(code) = code {
        // Clear so subsequent polls don't re-return the same token.
        *sh.code.lock().unwrap() = None;
        let verifier = sh.verifier.lock().unwrap().clone().unwrap_or_default();
        let token = exchange_code(&client_id, &client_secret, &verifier, &code).await?;
        eprintln!("[oauth] token exchanged ok");
        // Done with this flow's verifier.
        *sh.verifier.lock().unwrap() = None;
        *sh.state_expected.lock().unwrap() = None;
        Ok(token)
    } else {
        Ok(String::new())
    }
}

/// Tauri command — abort/discard any in-flight OAuth expectations.
#[tauri::command]
pub fn google_oauth_clear() -> Result<(), String> {
    let sh = shared();
    *sh.code.lock().unwrap() = None;
    *sh.verifier.lock().unwrap() = None;
    *sh.state_expected.lock().unwrap() = None;
    Ok(())
}

/// Strict RFC3986 percent-encode of a URL query component. Unreserved characters
/// are kept; everything else (including `:`, `/`, ` `, `%`, `&`, `=`, non-ASCII)
/// is percent-encoded so no value can break the query syntax.
fn percent_encode(s: &str) -> String {
    let unreserved = |b: u8| {
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~')
    };
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if unreserved(*b) {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
