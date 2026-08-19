//! lan_server.rs — experimental LAN sync server.
//!
//! Lets the mobile web app (e.g. Safari on an iPhone, same Wi-Fi) fetch the
//! desktop library and stream audio directly from the computer:
//!
//!   GET /api/library                 → JSON library (synced by the frontend)
//!   GET /api/playlists               → playlists + favorite track ids
//!   GET /audio/{id}                  → stream a local track (HTTP Range supported)
//!   GET /online/search?q=...         → merged Bilibili + YouTube search (proxy)
//!   GET /online/audio?source=&id=&title=&artist= → resolve to temp cache + stream
//!   GET / (and /assets/*)            → the built mobile web app (embedded UI)
//!
//! The web UI is served without a token (it is only the app shell). Every data
//! request must carry the per-start random token included in the URL the user
//! copies to the phone (`http://ip:17963/?token=...`) as a `token` query
//! parameter, so random websites cannot read the library. Experimental — no
//! transport encryption (LAN only).

use std::io::{Read, Seek, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use include_dir::{include_dir, Dir};

use crate::online;

pub const LAN_PORT: u16 = 17963;

/// The built mobile web app (dist-web), embedded at compile time so the
/// LAN server can serve the UI itself — no separate static file server needed.
static WEB_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist-web");

/// Paths that are part of the web UI and therefore do NOT require the token
/// (they are just the app shell; the API stays token-gated).
const WEB_STATIC_PREFIXES: [&str; 3] = ["/assets/", "/icons/", "/fonts/"];

/// Maximum concurrent connections (thread-per-connection DoS guard). Generous
/// enough that a few slow media-element streams can't starve the download
/// requests (which open a fresh connection per chunk).
const MAX_CONNECTIONS: usize = 32;

/// A track as synced from the desktop frontend. `file_path` is server-internal:
/// it is never serialized to clients (see `library()`).
///
/// `rename_all = "camelCase"` matches the keys the frontend sends
/// (`filePath`, `durationSecs`) — without it the command fails to deserialize,
/// the frontend swallows the error, and the server serves an empty library.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
// Accept the frontend's camelCase keys (filePath/durationSecs/trackIds) on
// input, but keep snake_case on output so API responses stay as documented.
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub struct LanTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_path: String,
    pub duration_secs: f64,
}

/// A playlist as synced from the desktop frontend, so the mobile web app sees
/// the same playlists (and favorites) as the desktop.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
// Accept camelCase trackIds on input; keep snake_case track_ids in responses.
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub struct LanPlaylist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
}

pub struct LanServer {
    tracks: Arc<Mutex<Vec<LanTrack>>>,
    playlists: Arc<Mutex<Vec<LanPlaylist>>>,
    favorite_ids: Arc<Mutex<Vec<String>>>,
    running: Arc<Mutex<bool>>,
    stop_flag: Arc<Mutex<bool>>,
    token: Arc<Mutex<String>>,
    conns: Arc<AtomicUsize>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl LanServer {
    pub fn new() -> Self {
        Self {
            tracks: Arc::new(Mutex::new(Vec::new())),
            playlists: Arc::new(Mutex::new(Vec::new())),
            favorite_ids: Arc::new(Mutex::new(Vec::new())),
            running: Arc::new(Mutex::new(false)),
            stop_flag: Arc::new(Mutex::new(false)),
            token: Arc::new(Mutex::new(String::new())),
            conns: Arc::new(AtomicUsize::new(0)),
            thread: Mutex::new(None),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().map(|r| *r).unwrap_or(false)
    }

    pub fn set_library(&self, tracks: Vec<LanTrack>) {
        if let Ok(mut t) = self.tracks.lock() {
            *t = tracks;
        }
    }

    pub fn set_playlists(&self, playlists: Vec<LanPlaylist>, favorite_ids: Vec<String>) {
        if let Ok(mut p) = self.playlists.lock() {
            *p = playlists;
        }
        if let Ok(mut f) = self.favorite_ids.lock() {
            *f = favorite_ids;
        }
    }

    /// Start the server and return the URL clients should open, e.g.
    /// `http://192.168.1.10:17963/?token=abc123`.
    pub fn start(&self) -> Result<String, String> {
        if self.is_running() {
            return self.url();
        }
        let listener = TcpListener::bind(("0.0.0.0", LAN_PORT))
            .map_err(|e| format!("Failed to bind LAN server on port {}: {}", LAN_PORT, e))?;
        // Non-blocking so the accept loop can observe the stop flag.
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure LAN server: {}", e))?;

        // Reset the stop flag (Start-after-Stop must work). The token is
        // persisted across restarts so the phone's saved address keeps working.
        if let Ok(mut f) = self.stop_flag.lock() {
            *f = false;
        }
        let token = load_or_create_token();
        if let Ok(mut t) = self.token.lock() {
            *t = token;
        }

        let tracks = self.tracks.clone();
        let playlists = self.playlists.clone();
        let favorite_ids = self.favorite_ids.clone();
        let running = self.running.clone();
        let stop_flag = self.stop_flag.clone();
        let token = self.token.clone();
        let conns = self.conns.clone();

        let handle = thread::spawn(move || {
            if let Ok(mut r) = running.lock() {
                *r = true;
            }
            loop {
                if stop_flag.lock().map(|f| *f).unwrap_or(true) {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        // Connection cap: refuse excess connections instead of
                        // spawning unbounded threads.
                        if conns.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
                            drop(stream);
                            continue;
                        }
                        conns.fetch_add(1, Ordering::Relaxed);
                        let tracks = tracks.clone();
                        let playlists = playlists.clone();
                        let favorite_ids = favorite_ids.clone();
                        let token = token.clone();
                        let conns_for_thread = conns.clone();
                        match thread::Builder::new().name("lan-conn".into()).spawn(move || {
                            handle_connection(stream, tracks, playlists, favorite_ids, token);
                            conns_for_thread.fetch_sub(1, Ordering::Relaxed);
                        }) {
                            Ok(_) => {}
                            Err(_) => {
                                // Spawn failed — release the slot immediately.
                                conns.fetch_sub(1, Ordering::Relaxed);
                            }
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(120));
                    }
                    Err(_) => break,
                }
            }
            if let Ok(mut r) = running.lock() {
                *r = false;
            }
        });

        if let Ok(mut t) = self.thread.lock() {
            *t = Some(handle);
        }

        self.url()
    }

    pub fn stop(&self) {
        if let Ok(mut f) = self.stop_flag.lock() {
            *f = true;
        }
        // Wait for the accept loop to exit (≤ ~120ms, non-blocking accept) so
        // a subsequent start() binds a fresh listener and issues a new token
        // without the old thread racing it.
        if let Ok(mut t) = self.thread.lock() {
            if let Some(h) = t.take() {
                let _ = h.join();
            }
        }
    }

    pub fn url(&self) -> Result<String, String> {
        let ip = lan_ip().ok_or("Cannot determine LAN IP address".to_string())?;
        let token = self.token.lock().map(|t| t.clone()).unwrap_or_default();
        Ok(format!("http://{}:{}/?token={}", ip, LAN_PORT, token))
    }
}

// ─── HTTP handling ─────────────────────────────────────

fn handle_connection(
    mut stream: TcpStream,
    tracks: Arc<Mutex<Vec<LanTrack>>>,
    playlists: Arc<Mutex<Vec<LanPlaylist>>>,
    favorite_ids: Arc<Mutex<Vec<String>>>,
    token: Arc<Mutex<String>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    // Generous write budget: a multi-hundred-MB file over slow Wi-Fi can take
    // minutes; a 60s write timeout would kill the transfer mid-body (which
    // surfaces on the phone as "download/stream failed").
    let _ = stream.set_write_timeout(Some(Duration::from_secs(300)));

    // Read headers (cap at 64 KB).
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let mut header_len: Option<usize> = None;
    while buf.len() < 64 * 1024 {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                    header_len = Some(pos);
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let Some(end) = header_len else {
        return;
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let target = parts.next().unwrap_or("/");

    // Headers we care about.
    let mut range_header: Option<String> = None;
    for line in lines {
        let lower = line.to_lowercase();
        if let Some((_, v)) = lower.split_once("range:") {
            range_header = Some(v.trim().to_string());
        }
    }

    // CORS preflight: answer generically without needing the token (the actual
    // request still requires it).
    if method == "OPTIONS" {
        write_response(&mut stream, 204, "No Content", &[], b"");
        return;
    }
    // HEAD is accepted too: iOS Safari's media loader sometimes probes audio
    // with HEAD before Range GETs. It reuses the GET handlers below (which
    // simply omit the response body).
    let is_head = method == "HEAD";
    if method != "GET" && !is_head {
        write_response(&mut stream, 405, "Method Not Allowed", &[], b"GET only");
        return;
    }

    let (path, query) = split_path_query(target);
    let route = path.trim_start_matches('/');

    // ── Web UI (no token needed — it is just the app shell) ──
    // Serve the built mobile app so opening the copied address on the phone
    // (http://ip:17963/?token=…) actually shows the player instead of a 404.
    if is_web_ui_route(path) {
        serve_web_ui(&mut stream, route);
        return;
    }

    // ── API — token gate ──
    // Every data request must carry the token from the shared URL. Compared in
    // constant time (LAN timing side-channel hardening). A helpful JSON error
    // is returned instead of a bare 404: most "it returned 404" reports come
    // from opening the URL without its token or after the server restarted
    // (which rotates the token).
    let expected = token.lock().map(|t| t.clone()).unwrap_or_default();
    let supplied = query_param(&query, "token").unwrap_or_default();
    if expected.is_empty() || !constant_time_eq(expected.as_bytes(), supplied.as_bytes()) {
        let body = br#"{"error":"invalid or missing token - open the full address shown in Settings > LAN Sync"}"#;
        write_response(&mut stream, 401, "Unauthorized", &[("Content-Type", "application/json")], body);
        return;
    }

    if route == "api/library" {
        let body = serde_json::to_string(&selfless_library(&tracks))
            .unwrap_or_else(|_| "{}".to_string());
        write_response(&mut stream, 200, "OK", &[("Content-Type", "application/json")], body.as_bytes());
        return;
    }

    if route == "api/playlists" {
        let body = serde_json::to_string(&playlists_payload(&playlists, &favorite_ids))
            .unwrap_or_else(|_| "{}".to_string());
        write_response(&mut stream, 200, "OK", &[("Content-Type", "application/json")], body.as_bytes());
        return;
    }

    if let Some(id) = route.strip_prefix("audio/") {
        let id = percent_decode(id);
        let track = tracks.lock().ok().and_then(|t| t.iter().find(|x| x.id == id).cloned());
        let Some(track) = track else {
            write_response(&mut stream, 404, "Not Found", &[], b"track not found");
            return;
        };
        let path = resolve_track_path(&track);
        match path {
            Ok(p) => stream_file(&mut stream, &p, range_header.as_deref(), is_head),
            Err(e) => write_response(&mut stream, 500, "Error", &[], e.as_bytes()),
        }
        return;
    }

    if route == "online/search" {
        let q = query_param(&query, "q").unwrap_or_default();
        let results = online::search_combined(&q);
        let body = serde_json::to_string(&results).unwrap_or_else(|_| "{}".to_string());
        write_response(&mut stream, 200, "OK", &[("Content-Type", "application/json")], body.as_bytes());
        return;
    }

    if route == "online/audio" {
        let source = query_param(&query, "source").unwrap_or_default();
        let mut id = query_param(&query, "id").unwrap_or_default();
        let title = query_param(&query, "title").unwrap_or_default();
        let artist = query_param(&query, "artist").unwrap_or_default();
        if source.is_empty() || id.is_empty() {
            write_response(&mut stream, 400, "Bad Request", &[], b"source and id required");
            return;
        }
        // yt-dlp parses leading `-` arguments as OPTIONS — never pass one
        // through, and for YouTube only accept canonical video URLs derived
        // from an extracted 11-char id (blocks SSRF to arbitrary hosts).
        if id.starts_with('-') {
            write_response(&mut stream, 400, "Bad Request", &[], b"invalid id");
            return;
        }
        if source == "youtube" {
            let Some(vid) = online::extract_youtube_id(&id) else {
                write_response(&mut stream, 400, "Bad Request", &[], b"invalid youtube id");
                return;
            };
            id = format!("https://www.youtube.com/watch?v={}", vid);
        }
        // Resolve (download to temp cache if needed) then stream. Token-gated,
        // so only the paired phone app can trigger downloads.
        match online::download_online_audio_unified(
            &source,
            &id,
            None,
            if title.is_empty() { None } else { Some(&title) },
            if artist.is_empty() { None } else { Some(&artist) },
        ) {
            Ok(path) => stream_file(&mut stream, Path::new(&path), range_header.as_deref(), is_head),
            Err(e) => write_response(&mut stream, 500, "Error", &[], e.as_bytes()),
        }
        return;
    }

    write_response(
        &mut stream,
        404,
        "Not Found",
        &[("Content-Type", "application/json")],
        br#"{"error":"not found"}"#,
    );
}

/// True for paths that belong to the embedded web UI (served without a token).
fn is_web_ui_route(path: &str) -> bool {
    path == "/" || path == "/index.html" || WEB_STATIC_PREFIXES.iter().any(|p| path.starts_with(p))
}

/// Serve a file from the embedded web build. `route` has no leading slash.
fn serve_web_ui(stream: &mut TcpStream, route: &str) {
    match lookup_web_file(route) {
        Some(f) => {
            // MIME from the resolved file name (the root route is "" but
            // serves index.html, so derive from the actual file).
            let name = f.path().to_string_lossy().replace('\\', "/");
            let mime = mime_for_static(&name);
            write_response(stream, 200, "OK", &[("Content-Type", mime)], f.contents());
        }
        None => write_response(stream, 404, "Not Found", &[], b"not found"),
    }
}

/// Resolve a UI route to an embedded file. Root/index → index.html; any other
/// path → exact match with an index.html fallback (client-side routing).
fn lookup_web_file(route: &str) -> Option<&'static include_dir::File<'static>> {
    let rel = route.trim_start_matches('/');
    if rel.is_empty() || rel == "index.html" {
        WEB_DIST.get_file("index.html")
    } else {
        WEB_DIST.get_file(rel).or_else(|| WEB_DIST.get_file("index.html"))
    }
}

/// Build the public library JSON (no file paths) from shared state.
fn selfless_library(tracks: &Mutex<Vec<LanTrack>>) -> serde_json::Value {
    let tracks = tracks.lock().map(|t| t.clone()).unwrap_or_default();
    let public: Vec<serde_json::Value> = tracks
        .iter()
        .map(|t| {
            // The real container/codec, derived from the file extension on the
            // server side (file_path itself never leaves the computer). The
            // phone uses it to pick the right playback element (e.g. m4a/mp4
            // through <video> on iOS) and to label the track.
            let codec = std::path::Path::new(&t.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "artist": t.artist,
                "album": t.album,
                "duration_secs": t.duration_secs,
                "codec": codec,
            })
        })
        .collect();
    serde_json::json!({ "tracks": public })
}

/// Build the playlists payload: playlists (id/name/track_ids) plus the flat
/// list of favorite track ids so the mobile app can restore hearts too.
fn playlists_payload(
    playlists: &Mutex<Vec<LanPlaylist>>,
    favorite_ids: &Mutex<Vec<String>>,
) -> serde_json::Value {
    let playlists = playlists.lock().map(|p| p.clone()).unwrap_or_default();
    let favorites = favorite_ids.lock().map(|f| f.clone()).unwrap_or_default();
    serde_json::json!({
        "playlists": playlists,
        "favorite_track_ids": favorites,
    })
}

/// Resolve a synced track to a playable file. Virtual online paths
/// (bilibili:// / youtube://) are resolved through the source API into the
/// temp cache, exactly like the desktop player does.
fn resolve_track_path(track: &LanTrack) -> Result<std::path::PathBuf, String> {
    if let Some(bvid) = track.file_path.strip_prefix("bilibili://") {
        return online::download_online_audio_unified("bilibili", bvid, None, None, None)
            .map(std::path::PathBuf::from);
    }
    if let Some(url) = track.file_path.strip_prefix("youtube://") {
        return online::download_online_audio_unified("youtube", url, None, None, None)
            .map(std::path::PathBuf::from);
    }
    Ok(std::path::PathBuf::from(&track.file_path))
}

/// Stream a file with optional HTTP Range support (needed for Safari seeking).
/// `head_only` sends the headers (status/Content-Length/Content-Range) but
/// omits the body, so iOS Safari's HEAD probes work.
fn stream_file(stream: &mut TcpStream, path: &Path, range: Option<&str>, head_only: bool) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => {
            write_response(stream, 404, "Not Found", &[], b"file not found");
            return;
        }
    };
    let total = meta.len();
    let mime = mime_for(path);
    let (start, end) = parse_range(range, total);

    // A byte-range request is only one that actually asks for "bytes=…".
    // Requests WITHOUT a Range header must get a plain 200 OK — iOS Safari's
    // media engine (AVFoundation) rejects a 206 to a non-range request, which
    // surfaces as "isn't playing on this device" even though the file streams
    // fine (this was the cause of LAN playback failing while fetch worked).
    let is_byte_range = range
        .map(|r| r.trim().to_ascii_lowercase().starts_with("bytes="))
        .unwrap_or(false);

    // Reject unsatisfiable / inverted ranges instead of underflowing.
    if total > 0 && start >= total || end < start {
        write_response(stream, 416, "Range Not Satisfiable", &[], b"");
        return;
    }
    let content_len = if total == 0 { 0 } else { end - start + 1 };

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            write_response(stream, 500, "Error", &[], b"open failed");
            return;
        }
    };
    if total > 0 && file.seek(std::io::SeekFrom::Start(start)).is_err() {
        write_response(stream, 500, "Error", &[], b"seek failed");
        return;
    }

    // 206 Partial Content ONLY when the client actually asked for a byte
    // range; otherwise 200 with the whole file. Both carry Accept-Ranges so
    // Safari can seek (its range requests then get exact 206s).
    let (status, reason) = if is_byte_range && total > 0 {
        (206, "Partial Content")
    } else {
        (200, "OK")
    };
    let mut out = format!("HTTP/1.1 {} {}\r\n", status, reason);
    out.push_str("Access-Control-Allow-Origin: *\r\n");
    out.push_str("Access-Control-Allow-Methods: GET, OPTIONS\r\n");
    out.push_str("Access-Control-Allow-Headers: Range, Content-Type\r\n");
    // no-cache: prevents a stale response being reused for a later Range
    // request on the same URL (the iOS chunked-download bug), while still
    // letting AVFoundation buffer the media (no-store can interfere with
    // iOS media playback).
    out.push_str("Cache-Control: no-cache\r\n");
    out.push_str(&format!("Content-Type: {}\r\n", mime));
    out.push_str("Accept-Ranges: bytes\r\n");
    if status == 206 {
        out.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, end, total));
    }
    out.push_str(&format!("Content-Length: {}\r\n", content_len));
    out.push_str("Connection: close\r\n\r\n");
    if stream.write_all(out.as_bytes()).is_err() {
        return;
    }
    // HEAD probes only need the headers.
    if head_only {
        return;
    }

    // Stream the body in chunks (avoids loading large FLACs fully into memory).
    let mut chunk = [0u8; 64 * 1024];
    let mut remaining = content_len;
    while remaining > 0 {
        let want = std::cmp::min(remaining as usize, chunk.len());
        match file.read(&mut chunk[..want]) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&chunk[..n]).is_err() {
                    return;
                }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
}

fn write_response(stream: &mut TcpStream, status: u16, reason: &str, extra: &[(&str, &str)], body: &[u8]) {
    let mut out = format!("HTTP/1.1 {} {}\r\n", status, reason);
    out.push_str("Access-Control-Allow-Origin: *\r\n");
    out.push_str("Access-Control-Allow-Methods: GET, OPTIONS\r\n");
    out.push_str("Access-Control-Allow-Headers: Range, Content-Type\r\n");
    for (k, v) in extra {
        out.push_str(&format!("{}: {}\r\n", k, v));
    }
    out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    out.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.write_all(body);
}

// ─── Small helpers ─────────────────────────────────────

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Where the LAN token is persisted so it survives app restarts (the phone's
/// saved address keeps working instead of 401-ing after every restart).
fn token_file_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("NeedMusic").join("lan_token.txt")
}

/// Reuse the persisted token if present, otherwise generate and save a new one.
fn load_or_create_token() -> String {
    let path = token_file_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim().to_string();
        if !t.is_empty() {
            // Self-heal perms on files created by older builds (or in the
            // shared temp-dir fallback) so they aren't world-readable.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            return t;
        }
    }
    let token = generate_token();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(&path, &token);
        // Don't leave the token world-readable — on non-Windows where
        // APPDATA is unset the file falls back to the shared temp dir.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
    token
}

/// Constant-time byte comparison (no early exit on the first mismatch).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn split_path_query(target: &str) -> (&str, &str) {
    match target.find('?') {
        Some(pos) => (&target[..pos], &target[pos + 1..]),
        None => (target, ""),
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None => (pair, ""),
        };
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_range(range: Option<&str>, total: u64) -> (u64, u64) {
    if total == 0 {
        return (0, 0);
    }
    let Some(r) = range else {
        return (0, total.saturating_sub(1));
    };
    let spec = r.trim();
    let spec = spec.strip_prefix("bytes=").unwrap_or(spec);
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return (0, total.saturating_sub(1));
    };
    let start: u64 = start_s.trim().parse().unwrap_or(0);
    if start_s.trim().is_empty() {
        // suffix range: last N bytes
        let n: u64 = end_s.trim().parse().unwrap_or(0);
        if n == 0 {
            return (0, total.saturating_sub(1));
        }
        return (total.saturating_sub(n), total.saturating_sub(1));
    }
    let end: u64 = match end_s.trim().parse() {
        Ok(e) => e,
        Err(_) => total.saturating_sub(1),
    };
    (start, end.min(total.saturating_sub(1)))
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "flac" => "audio/flac",
        // .mp4 is usually a video container (YouTube downloads) → video/mp4;
        // .m4a is pure audio.
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "wma" => "audio/x-ms-wma",
        "aiff" => "audio/aiff",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// MIME type for files served from the embedded web build.
fn mime_for_static(rel: &str) -> &'static str {
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Best-effort LAN IP (UDP connect trick — sends no packets).
fn lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recursively collect every embedded file (Dir::files() is non-recursive).
    fn collect_files<'a>(dir: &'a Dir<'static>) -> Vec<&'a include_dir::File<'static>> {
        let mut out: Vec<&include_dir::File> = dir.files().collect();
        for sub in dir.dirs() {
            out.extend(collect_files(sub));
        }
        out
    }

    #[test]
    fn web_ui_lookup_serves_app_shell() {
        // The whole point of the LAN fix: opening the server root must serve
        // the app, not a 404.
        assert!(lookup_web_file("").is_some(), "root must serve index.html");
        assert!(lookup_web_file("index.html").is_some());
        // Hashed bundles from the relative-base build live under /assets/.
        let all: Vec<&include_dir::File> = collect_files(&WEB_DIST);
        let js = all.iter().find(|f| f.path().extension().map(|e| e == "js").unwrap_or(false));
        let css = all.iter().find(|f| f.path().extension().map(|e| e == "css").unwrap_or(false));
        assert!(js.is_some(), "JS bundle must be embedded");
        assert!(css.is_some(), "CSS bundle must be embedded");
        // And those files must be reachable through the lookup.
        let js_file = js.expect("js bundle");
        assert!(lookup_web_file(js_file.path().to_str().unwrap()).is_some(), "JS bundle reachable");
    }

    #[test]
    fn static_mime_types() {
        assert_eq!(mime_for_static("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for_static("assets/app.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for_static("assets/app.css"), "text/css; charset=utf-8");
        assert_eq!(mime_for_static("assets/x.webmanifest"), "application/manifest+json");
        assert_eq!(mime_for_static("assets/pic.png"), "image/png");
    }

    #[test]
    fn audio_mime_mapping() {
        assert_eq!(mime_for(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_for(Path::new("a.flac")), "audio/flac");
        // .m4a is pure audio; .mp4 is a (possibly video) container.
        assert_eq!(mime_for(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_for(Path::new("a.mp4")), "video/mp4");
    }

    #[test]
    fn token_gate_routes_are_not_web_ui() {
        // API/streaming paths must never be served as static UI — they stay
        // behind the token gate.
        for api in ["/api/library", "/audio/abc", "/online/search"] {
            assert!(!is_web_ui_route(api), "{api} must stay token-gated");
        }
        // The app shell and its bundles are served without a token.
        assert!(is_web_ui_route("/"));
        assert!(is_web_ui_route("/index.html"));
        assert!(is_web_ui_route("/assets/index.js"));
    }

    #[test]
    fn frontend_payload_deserializes() {
        // The desktop frontend sends tracks with camelCase keys
        // (filePath, durationSecs) and playlists with trackIds. Without serde
        // rename_all these fail to deserialize, the frontend swallows the
        // error, and the LAN server silently serves an empty library —
        // "connected, but 0 tracks are added".
        let tracks_json = r#"[{"id":"t1","title":"Song","artist":"A","album":"B","filePath":"C:\\Music\\a.mp3","durationSecs":120.0}]"#;
        let tracks: Vec<LanTrack> = serde_json::from_str(tracks_json)
            .expect("LanTrack must accept the frontend's camelCase payload");
        assert_eq!(tracks[0].file_path, "C:\\Music\\a.mp3");
        assert_eq!(tracks[0].duration_secs, 120.0);

        let playlists_json = r#"[{"id":"pl1","name":"Chill","trackIds":["t1"]}]"#;
        let playlists: Vec<LanPlaylist> = serde_json::from_str(playlists_json)
            .expect("LanPlaylist must accept the frontend's camelCase payload");
        assert_eq!(playlists[0].track_ids, vec!["t1".to_string()]);

        // Responses must stay snake_case — the mobile app reads `track_ids`.
        let out = serde_json::to_string(&playlists).unwrap();
        assert!(out.contains("track_ids"), "response must use track_ids: {out}");
        assert!(!out.contains("trackIds"), "response must not use trackIds: {out}");
    }

    #[test]
    fn audio_stream_serves_file_with_cors() {
        // Playback on the phone = GET /audio/{id}?token=… → stream the file.
        // Verify status, content-type, CORS headers, and the exact bytes.
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        // Temp audio file.
        let dir = std::env::temp_dir().join(format!("needmusic-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("song.mp3");
        let bytes = vec![0x49, 0x44, 0x33, 0x01, 0x02, 0x03, 0xAA, 0xBB, 0xCC, 0xDD]; // fake mp3
        std::fs::write(&file, &bytes).unwrap();

        let tracks = Arc::new(Mutex::new(vec![LanTrack {
            id: "track_abc123".into(),
            title: "Song".into(),
            artist: "A".into(),
            album: "B".into(),
            file_path: file.to_string_lossy().to_string(),
            duration_secs: 100.0,
        }]));
        let playlists = Arc::new(Mutex::new(Vec::new()));
        let favorite_ids = Arc::new(Mutex::new(Vec::new()));
        let token = Arc::new(Mutex::new("tok123".into()));

        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                handle_connection(stream, tracks.clone(), playlists.clone(), favorite_ids.clone(), token.clone());
            }
        });

        let mut resp = http_get_bytes(addr, "GET /audio/track_abc123?token=tok123 HTTP/1.1\r\nHost: t\r\n\r\n");
        let mut resp_str = String::from_utf8_lossy(&resp);
        // A request WITHOUT a Range header gets a plain 200 + full body —
        // iOS Safari's media engine rejects a 206 to a non-range request
        // (which previously surfaced as "isn't playing on this device" even
        // though fetch worked).
        assert!(resp_str.starts_with("HTTP/1.1 200"), "no-range audio must be 200: {resp_str:?}");
        assert!(resp_str.contains("audio/mpeg"), "mime must be audio/mpeg: {resp_str:?}");
        assert!(resp_str.contains("Accept-Ranges: bytes"), "accept-ranges: {resp_str:?}");
        assert!(resp_str.contains("Cache-Control: no-cache"), "no-cache: {resp_str:?}");
        assert!(resp_str.contains("Access-Control-Allow-Origin: *"), "CORS for fetch: {resp_str:?}");
        assert!(!resp_str.contains("Content-Range"), "no-range response must not claim partial content: {resp_str:?}");
        assert!(resp.ends_with(&bytes), "body must be the exact file bytes");

        // Safari's <audio> element seeks via HTTP Range — must return 206.
        resp = http_get_bytes(addr, "GET /audio/track_abc123?token=tok123 HTTP/1.1\r\nHost: t\r\nRange: bytes=2-5\r\n\r\n");
        resp_str = String::from_utf8_lossy(&resp);
        assert!(resp_str.starts_with("HTTP/1.1 206"), "range must be 206: {resp_str:?}");
        assert!(resp_str.contains("Content-Range: bytes 2-5/10"), "content-range: {resp_str:?}");
        assert_eq!(&resp[resp.len() - 4..], &bytes[2..6], "range body must be bytes 2..6");

        let _ = std::fs::remove_dir_all(&dir);
        server.join().unwrap();
    }

    #[test]
    fn large_file_streams_correctly() {
        // Downloads fetch a real file in ~512 KB chunks. Verify the server
        // answers large ranges with the EXACT bytes and Content-Length (a
        // truncated/mismatched body surfaces on the phone as a failed chunk).
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let dir = std::env::temp_dir().join(format!("needmusic-large-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("song.mp3");
        let size = 5 * 1024 * 1024 + 123; // just over 5 MB
        let mut bytes = vec![0u8; size];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (i.wrapping_mul(31) & 0xff) as u8;
        }
        std::fs::write(&file, &bytes).unwrap();

        let tracks = Arc::new(Mutex::new(vec![LanTrack {
            id: "t_big".into(),
            title: "Big".into(),
            artist: "A".into(),
            album: "B".into(),
            file_path: file.to_string_lossy().to_string(),
            duration_secs: 300.0,
        }]));
        let playlists = Arc::new(Mutex::new(Vec::new()));
        let favorite_ids = Arc::new(Mutex::new(Vec::new()));
        let token = Arc::new(Mutex::new("tok123".into()));

        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (stream, _) = listener.accept().unwrap();
                handle_connection(stream, tracks.clone(), playlists.clone(), favorite_ids.clone(), token.clone());
            }
        });

        // 1) Whole file (no Range) → 200, exact Content-Length, full body.
        let resp = http_get_bytes(addr, "GET /audio/t_big?token=tok123 HTTP/1.1\r\nHost: t\r\n\r\n");
        let head = String::from_utf8_lossy(&resp[..resp.len().min(4096)]).to_string();
        assert!(head.starts_with("HTTP/1.1 200"), "whole file must be 200: {head:?}");
        assert!(head.contains(&format!("Content-Length: {}", size)), "content-length: {head:?}");
        // resp = headers + body; the body must be the complete file.
        assert!(resp.ends_with(&bytes), "body must be the complete file (got {} bytes, file {})", resp.len(), size);

        // 2) First 512 KB chunk → 206, exact Content-Range, exact bytes.
        let resp = http_get_bytes(addr, "GET /audio/t_big?token=tok123 HTTP/1.1\r\nHost: t\r\nRange: bytes=0-524287\r\n\r\n");
        let head = String::from_utf8_lossy(&resp[..resp.len().min(4096)]).to_string();
        assert!(head.starts_with("HTTP/1.1 206"), "chunk must be 206: {head:?}");
        assert!(head.contains(&format!("Content-Range: bytes 0-524287/{}", size)), "content-range: {head:?}");
        assert!(resp.ends_with(&bytes[..524288]), "chunk body must be bytes 0..524288");

        // 3) Second chunk starting mid-file.
        let resp = http_get_bytes(addr, "GET /audio/t_big?token=tok123 HTTP/1.1\r\nHost: t\r\nRange: bytes=524288-1048575\r\n\r\n");
        let head = String::from_utf8_lossy(&resp[..resp.len().min(4096)]).to_string();
        assert!(head.starts_with("HTTP/1.1 206"), "chunk 2 must be 206: {head:?}");
        assert!(head.contains(&format!("Content-Range: bytes 524288-1048575/{}", size)), "content-range 2: {head:?}");
        assert!(resp.ends_with(&bytes[524288..1048576]), "chunk 2 body must be bytes 524288..1048576");

        let _ = std::fs::remove_dir_all(&dir);
        server.join().unwrap();
    }

    #[test]
    fn head_probe_returns_headers_without_body() {
        // iOS Safari's media loader probes audio with HEAD before Range GETs.
        // The response must include the media headers but no body bytes.
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let dir = std::env::temp_dir().join(format!("needmusic-head-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("song.m4a");
        let bytes = vec![0x00; 128];
        std::fs::write(&file, &bytes).unwrap();

        let tracks = Arc::new(Mutex::new(vec![LanTrack {
            id: "t_head".into(),
            title: "Song".into(),
            artist: "A".into(),
            album: "B".into(),
            file_path: file.to_string_lossy().to_string(),
            duration_secs: 10.0,
        }]));
        let playlists = Arc::new(Mutex::new(Vec::new()));
        let favorite_ids = Arc::new(Mutex::new(Vec::new()));
        let token = Arc::new(Mutex::new("tok123".into()));

        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                handle_connection(stream, tracks.clone(), playlists.clone(), favorite_ids.clone(), token.clone());
            }
        });

        // HEAD without a Range header → 200 + full Content-Length, no body.
        let resp = http_get_bytes(addr, "HEAD /audio/t_head?token=tok123 HTTP/1.1\r\nHost: t\r\n\r\n");
        let resp_str = String::from_utf8_lossy(&resp);
        assert!(resp_str.starts_with("HTTP/1.1 200"), "HEAD media must be 200: {resp_str:?}");
        assert!(resp_str.contains("Content-Length: 128"), "content-length: {resp_str:?}");
        assert!(resp_str.contains("audio/mp4"), "mime must be audio/mp4: {resp_str:?}");
        assert!(resp_str.contains("Accept-Ranges: bytes"), "accept-ranges: {resp_str:?}");
        assert!(!resp_str.contains("Content-Range"), "no-range HEAD must not claim partial content: {resp_str:?}");
        // No body after the header terminator.
        let body = resp_str.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(body.is_empty(), "HEAD must not send a body: {resp_str:?}");

        // HEAD with a Range header → 206 + Content-Range, still no body.
        let resp = http_get_bytes(addr, "HEAD /audio/t_head?token=tok123 HTTP/1.1\r\nHost: t\r\nRange: bytes=10-19\r\n\r\n");
        let resp_str = String::from_utf8_lossy(&resp);
        assert!(resp_str.starts_with("HTTP/1.1 206"), "range HEAD must be 206: {resp_str:?}");
        assert!(resp_str.contains("Content-Range: bytes 10-19/128"), "content-range: {resp_str:?}");
        let body = resp_str.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(body.is_empty(), "range HEAD must not send a body: {resp_str:?}");

        let _ = std::fs::remove_dir_all(&dir);
        server.join().unwrap();
    }

    #[test]
    fn end_to_end_http_routing() {
        // Start a listener, serve one connection through handle_connection,
        // and verify the exact responses a phone would see.
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let tracks = Arc::new(Mutex::new(vec![LanTrack {
            id: "t1".into(),
            title: "Test Song".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            file_path: "/nonexistent/test.mp3".into(),
            duration_secs: 120.0,
        }]));
        let playlists = Arc::new(Mutex::new(vec![LanPlaylist {
            id: "pl1".into(),
            name: "Chill".into(),
            track_ids: vec!["t1".into()],
        }]));
        let favorite_ids = Arc::new(Mutex::new(vec!["t1".into()]));
        let token = Arc::new(Mutex::new("secrettoken123".into()));

        // Accept a connection per request (each http_get opens its own socket).
        let server = std::thread::spawn(move || {
            for _ in 0..6 {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let t = tracks.clone();
                        let pl = playlists.clone();
                        let favs = favorite_ids.clone();
                        let tok = token.clone();
                        handle_connection(stream, t, pl, favs, tok);
                    }
                    Err(_) => break,
                }
            }
        });

        // ── 1) Root WITHOUT token → the web app shell (the old 404) ──
        let resp = http_get(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n");
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "root must serve the app: {resp:?}");
        assert!(resp.contains("text/html"), "root must be html: {resp:?}");
        assert!(resp.contains("NeedMusic"), "root must contain the app: {resp:?}");

        // ── 2) Static bundle WITHOUT token → served (UI needs no token) ──
        // Grab the real hashed asset path from the served index.html.
        let js_asset = resp
            .split("src=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or("assets/index.js")
            .trim_start_matches("./");
        let resp = http_get(addr, &format!("GET /{js_asset} HTTP/1.1\r\nHost: t\r\n\r\n"));
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "assets must be served: {resp:?}");
        assert!(resp.contains("text/javascript"), "assets must have js mime: {resp:?}");

        // ── 3) API WITHOUT token → 401 with a helpful JSON error ──
        let resp = http_get(addr, "GET /api/library HTTP/1.1\r\nHost: t\r\n\r\n");
        assert!(resp.starts_with("HTTP/1.1 401"), "api without token must 401: {resp:?}");
        assert!(resp.contains("invalid or missing token"), "error must be helpful: {resp:?}");

        // ── 4) API WITH token → the library JSON ──
        let resp = http_get(addr, "GET /api/library?token=secrettoken123 HTTP/1.1\r\nHost: t\r\n\r\n");
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "api with token must 200: {resp:?}");
        assert!(resp.contains("\"Test Song\""), "library must contain the track: {resp:?}");
        // file_path must never leak to clients, but the codec (derived from
        // the extension server-side) is sent so the phone picks the right
        // playback element.
        assert!(!resp.contains("test.mp3"), "file_path must not be serialized: {resp:?}");
        assert!(resp.contains("\"codec\":\"mp3\""), "codec must be derived and sent: {resp:?}");

        // ── 5) Wrong token → 401, not a bare 404 ──
        let resp = http_get(addr, "GET /api/library?token=wrong HTTP/1.1\r\nHost: t\r\n\r\n");
        assert!(resp.starts_with("HTTP/1.1 401"), "wrong token must 401: {resp:?}");

        // ── 6) Playlists + favorites sync payload (with token) ──
        let resp = http_get(addr, "GET /api/playlists?token=secrettoken123 HTTP/1.1\r\nHost: t\r\n\r\n");
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "playlists must 200: {resp:?}");
        assert!(resp.contains("\"Chill\""), "playlist name must be present: {resp:?}");
        assert!(resp.contains("\"t1\""), "playlist track ids must be present: {resp:?}");
        assert!(resp.contains("favorite_track_ids"), "favorites must be present: {resp:?}");

        server.join().unwrap();
    }

    /// Minimal raw HTTP client (no external deps).
    fn http_get(addr: std::net::SocketAddr, request: &str) -> String {
        use std::io::Read as _;
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        out
    }

    /// Same, but binary-safe (for audio bodies).
    fn http_get_bytes(addr: std::net::SocketAddr, request: &str) -> Vec<u8> {
        use std::io::Read as _;
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        out
    }
}
