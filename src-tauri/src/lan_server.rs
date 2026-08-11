//! lan_server.rs — experimental LAN sync server.
//!
//! Lets the mobile web app (e.g. Safari on an iPhone, same Wi-Fi) fetch the
//! desktop library and stream audio directly from the computer:
//!
//!   GET /api/library                 → JSON library (synced by the frontend)
//!   GET /audio/{id}                  → stream a local track (HTTP Range supported)
//!   GET /online/search?q=...         → merged Bilibili + YouTube search (proxy)
//!   GET /online/audio?source=&id=&title=&artist= → resolve to temp cache + stream
//!
//! Access is gated by a per-start random token included in the URL the user
//! copies to the phone (`http://ip:17963/?token=...`). Every request must
//! carry it as a `token` query parameter, so random websites cannot reach the
//! server. Experimental — no transport encryption (LAN only).

use std::io::{Read, Seek, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::online;

pub const LAN_PORT: u16 = 17963;

/// Maximum concurrent connections (thread-per-connection DoS guard).
const MAX_CONNECTIONS: usize = 8;

/// A track as synced from the desktop frontend. `file_path` is server-internal:
/// it is never serialized to clients (see `library()`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LanTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_path: String,
    pub duration_secs: f64,
}

pub struct LanServer {
    tracks: Arc<Mutex<Vec<LanTrack>>>,
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

        // Reset the stop flag (Start-after-Stop must work) and issue a fresh token.
        if let Ok(mut f) = self.stop_flag.lock() {
            *f = false;
        }
        let token = generate_token();
        if let Ok(mut t) = self.token.lock() {
            *t = token;
        }

        let tracks = self.tracks.clone();
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
                        let token = token.clone();
                        let conns_for_thread = conns.clone();
                        match thread::Builder::new().name("lan-conn".into()).spawn(move || {
                            handle_connection(stream, tracks, token);
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

fn handle_connection(mut stream: TcpStream, tracks: Arc<Mutex<Vec<LanTrack>>>, token: Arc<Mutex<String>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));

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
    if method != "GET" {
        write_response(&mut stream, 405, "Method Not Allowed", &[], b"GET only");
        return;
    }

    let (path, query) = split_path_query(target);

    // Token gate — every request must carry the token from the shared URL.
    // Compared in constant time (LAN timing side-channel hardening).
    let expected = token.lock().map(|t| t.clone()).unwrap_or_default();
    let supplied = query_param(&query, "token").unwrap_or_default();
    if expected.is_empty() || !constant_time_eq(expected.as_bytes(), supplied.as_bytes()) {
        write_response(&mut stream, 404, "Not Found", &[], b"");
        return;
    }

    let route = path.trim_start_matches('/');

    if route == "api/library" {
        let body = serde_json::to_string(&selfless_library(&tracks))
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
            Ok(p) => stream_file(&mut stream, &p, range_header.as_deref()),
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
            Ok(path) => stream_file(&mut stream, Path::new(&path), range_header.as_deref()),
            Err(e) => write_response(&mut stream, 500, "Error", &[], e.as_bytes()),
        }
        return;
    }

    write_response(
        &mut stream,
        200,
        "OK",
        &[("Content-Type", "text/plain; charset=utf-8")],
        b"NeedMusic LAN Sync (experimental)\nGET /api/library  |  GET /audio/{id}  |  GET /online/search?q=  |  GET /online/audio",
    );
}

/// Build the public library JSON (no file paths) from shared state.
fn selfless_library(tracks: &Mutex<Vec<LanTrack>>) -> serde_json::Value {
    let tracks = tracks.lock().map(|t| t.clone()).unwrap_or_default();
    let public: Vec<serde_json::Value> = tracks
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "artist": t.artist,
                "album": t.album,
                "duration_secs": t.duration_secs,
            })
        })
        .collect();
    serde_json::json!({ "tracks": public })
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
fn stream_file(stream: &mut TcpStream, path: &Path, range: Option<&str>) {
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

    let (status, reason) = if range.is_some() { (206, "Partial Content") } else { (200, "OK") };
    let mut out = format!("HTTP/1.1 {} {}\r\n", status, reason);
    out.push_str("Access-Control-Allow-Origin: *\r\n");
    out.push_str("Access-Control-Allow-Methods: GET, OPTIONS\r\n");
    out.push_str("Access-Control-Allow-Headers: Range, Content-Type\r\n");
    out.push_str(&format!("Content-Type: {}\r\n", mime));
    out.push_str("Accept-Ranges: bytes\r\n");
    if let Some(_r) = range {
        out.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, end, total));
    }
    out.push_str(&format!("Content-Length: {}\r\n", content_len));
    out.push_str("Connection: close\r\n\r\n");
    if stream.write_all(out.as_bytes()).is_err() {
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
        "m4a" | "mp4" => "audio/mp4",
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

/// Best-effort LAN IP (UDP connect trick — sends no packets).
fn lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}
