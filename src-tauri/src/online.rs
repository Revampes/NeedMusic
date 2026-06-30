/// online.rs — Bilibili & YouTube music search & audio download.
///
/// Bilibili: Uses public REST API directly (no external tools needed).
///            Implements Wbi signing for authenticated API access.
/// YouTube:  Uses yt-dlp CLI for search & audio download.
///           User must enable YouTube search in Settings (grey area).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::time::{SystemTime, UNIX_EPOCH};

// ─── Types ────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct OnlineTrackResult {
    pub source: String,       // "bilibili" or "youtube"
    pub id: String,           // bvid for Bilibili, video ID for YouTube
    pub bvid: String,         // kept for backward compat (same as id for Bilibili)
    pub title: String,
    pub author: String,
    pub duration: String,     // human‑readable like "3:45"
    pub duration_secs: f64,
    pub cover_url: String,
    pub description: String,
    pub url: String,          // full URL (YouTube needs this for download)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OnlineSearchResult {
    pub results: Vec<OnlineTrackResult>,
    pub total: u64,
}

/// Combined search result from both sources.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CombinedSearchResult {
    pub bilibili: OnlineSearchResult,
    pub youtube: OnlineSearchResult,
}

// ─── Wbi Signing ──────────────────────────────────────

/// Cached Wbi keys. Refreshed when they expire or fail.
struct WbiKeys {
    #[allow(dead_code)]
    img_key: String,
    #[allow(dead_code)]
    sub_key: String,
    mixed_key: String,
    fetched_at: u64,
}

static WBI_CACHE: Mutex<Option<WbiKeys>> = Mutex::new(None);

/// The fixed mixing table from Bilibili's frontend JS.
const MIXIN_TABLE: [usize; 32] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

fn http_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("Failed to build HTTP client")
}

/// Fetch or refresh the Wbi signing keys from Bilibili's nav endpoint.
fn get_wbi_keys() -> Result<String, String> {
    // Check cache (keys valid for ~1 hour, but we refresh on failure).
    {
        let cache = WBI_CACHE.lock().unwrap();
        if let Some(ref keys) = *cache {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            if now - keys.fetched_at < 3600 {
                return Ok(keys.mixed_key.clone());
            }
        }
    }

    let client = http_client();
    let resp = client
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header("Referer", "https://www.bilibili.com/")
        .send()
        .map_err(|e| format!("Failed to fetch Wbi keys: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .map_err(|e| format!("Invalid Wbi response: {}", e))?;

    let wbi = &json["data"]["wbi_img"];
    let img_url = wbi["img_url"].as_str().unwrap_or("");
    let sub_url = wbi["sub_url"].as_str().unwrap_or("");

    if img_url.is_empty() || sub_url.is_empty() {
        return Err("Wbi keys not found in nav response".to_string());
    }

    let img_key = extract_key_from_url(img_url);
    let sub_key = extract_key_from_url(sub_url);

    let combined = img_key.clone() + &sub_key;
    let mixed: String = MIXIN_TABLE.iter().map(|&i| {
        combined.chars().nth(i).unwrap_or(' ')
    }).collect();

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let mut cache = WBI_CACHE.lock().unwrap();
    *cache = Some(WbiKeys {
        img_key,
        sub_key,
        mixed_key: mixed.clone(),
        fetched_at: now,
    });

    Ok(mixed)
}

/// Extract the filename without extension from a Wbi URL.
/// e.g. "https://i0.hdslb.com/bfs/wbi/7cd08494...png" → "7cd08494..."
fn extract_key_from_url(url: &str) -> String {
    let path = url.rsplit('/').next().unwrap_or("");
    path.rsplit('.').nth(1).unwrap_or(path).to_string()
}

/// Sign a list of query parameters with Wbi.
/// Adds w_rid and wts to the params in-place.
fn sign_params(params: &mut Vec<(String, String)>) -> Result<(), String> {
    let mixed_key = get_wbi_keys()?;

    let wts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    // Sort params alphabetically.
    params.sort_by(|a, b| a.0.cmp(&b.0));

    // Build the string to hash: sorted params + mixed_key.
    let mut to_hash = String::new();
    for (k, v) in params.iter() {
        let clean_v: String = v.chars()
            .filter(|c| !matches!(c, '!' | '\'' | '(' | ')' | '*'))
            .collect();
        to_hash.push_str(&format!("{}={}&", k, clean_v));
    }
    to_hash.push_str(&mixed_key);

    let w_rid = format!("{:x}", md5::compute(to_hash.as_bytes()));

    params.push(("w_rid".to_string(), w_rid));
    params.push(("wts".to_string(), wts));

    Ok(())
}

/// Build a signed URL for a Bilibili API endpoint.
fn make_signed_url(base: &str, params: &[(&str, &str)]) -> Result<String, String> {
    let mut v: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    sign_params(&mut v)?;

    let qs: Vec<String> = v
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode(k), url_encode(v)))
        .collect();
    Ok(format!("{}?{}", base, qs.join("&")))
}

fn url_encode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b' ' => result.push_str("%20"),
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

// ─── Bilibili Search (native API) ─────────────────────

/// Fetch a URL and parse the response as JSON, with retries on transient failures.
/// Returns the JSON value or an error with diagnostics (HTTP status + body snippet).
fn fetch_json_with_retry(url: &str, label: &str) -> Result<serde_json::Value, String> {
    let client = http_client();
    let mut last_err = String::new();

    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500 * (1 << (attempt - 1))));
        }

        let resp = match client
            .get(url)
            .header("Referer", "https://www.bilibili.com/")
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("{} request failed: {}", label, e);
                continue;
            }
        };

        let status = resp.status();
        let body = match resp.text() {
            Ok(b) => b,
            Err(e) => {
                last_err = format!("{}: failed to read response body: {}", label, e);
                continue;
            }
        };

        // If the response body is empty, retry.
        if body.trim().is_empty() {
            last_err = format!("{}: empty response body (HTTP {})", label, status.as_u16());
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(json) => return Ok(json),
            Err(e) => {
                let snippet: String = body
                    .chars()
                    .take(200)
                    .collect();
                last_err = format!(
                    "Invalid {} response (HTTP {}): {}. Body: {}",
                    label,
                    status.as_u16(),
                    e,
                    snippet
                );
                continue;
            }
        }
    }

    Err(last_err)
}

pub fn search_bilibili(query: &str) -> Result<OnlineSearchResult, String> {
    let url = make_signed_url(
        "https://api.bilibili.com/x/web-interface/search/type",
        &[
            ("search_type", "video"),
            ("keyword", query),
            ("page", "1"),
            ("page_size", "20"),
        ],
    )?;

    let json: serde_json::Value = fetch_json_with_retry(&url, "search")?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code == -799 {
        // Wbi keys expired — clear cache and retry once.
        {
            let mut cache = WBI_CACHE.lock().unwrap();
            *cache = None;
        }
        return search_bilibili(query);
    }
    if code != 0 {
        let msg = json["message"].as_str().unwrap_or("Unknown error");
        return Err(format!("Bilibili API error ({}): {}", code, msg));
    }

    let data = &json["data"]["result"];
    let results_arr = data.as_array().ok_or("No results array in response")?;

    let mut results: Vec<OnlineTrackResult> = Vec::new();
    for item in results_arr {
        let bvid = item["bvid"].as_str().unwrap_or("").to_string();
        if bvid.is_empty() {
            continue;
        }
        let title = html_unescape(item["title"].as_str().unwrap_or("Unknown"));
        let author = item["author"].as_str().unwrap_or("Unknown").to_string();
        let duration_parts = item["duration"].as_str().unwrap_or("0:00").to_string();
        let duration_secs = parse_duration(&duration_parts);
        let duration = fmt_secs(duration_secs);
        let cover_url = item["pic"].as_str().unwrap_or("").to_string();
        // Normalize cover URL: handle protocol-relative (//...) and http.
        let cover_url = if cover_url.starts_with("//") {
            format!("https:{}", cover_url)
        } else {
            cover_url.replace("http://", "https://")
        };
        let description = item["description"].as_str().unwrap_or("").to_string();
        let bilibili_url = format!("https://www.bilibili.com/video/{}", bvid);

        results.push(OnlineTrackResult {
            source: "bilibili".to_string(),
            id: bvid.clone(),
            bvid,
            title,
            author,
            duration,
            duration_secs,
            cover_url,
            description,
            url: bilibili_url,
        });
    }

    let total = data["numResults"].as_u64().unwrap_or(results.len() as u64);
    Ok(OnlineSearchResult { results, total })
}

fn html_unescape(s: &str) -> String {
    // First strip HTML tags like <em class="keyword">...</em>
    let stripped = strip_html_tags(s);
    stripped
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
}

/// Remove all HTML tags from a string (e.g. `<em class="keyword">foo</em>` → `foo`).
fn strip_html_tags(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    result
}

fn parse_duration(s: &str) -> f64 {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        3 => {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let secs: f64 = parts[2].parse().unwrap_or(0.0);
            h * 3600.0 + m * 60.0 + secs
        }
        2 => {
            let m: f64 = parts[0].parse().unwrap_or(0.0);
            let secs: f64 = parts[1].parse().unwrap_or(0.0);
            m * 60.0 + secs
        }
        _ => 0.0,
    }
}

fn fmt_secs(secs: f64) -> String {
    if secs <= 0.0 {
        return "?:??".to_string();
    }
    let total = secs as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{}:{:02}", m, s)
    }
}

// ─── Audio URL Resolution ─────────────────────────────

/// Get the best audio stream URL for a Bilibili video.
fn get_audio_url(bvid: &str) -> Result<String, String> {
    // First get the cid from video info.
    let info_url = make_signed_url(
        "https://api.bilibili.com/x/web-interface/view",
        &[("bvid", bvid)],
    )?;

    let json: serde_json::Value = fetch_json_with_retry(&info_url, "video info")?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code == -799 {
        let mut cache = WBI_CACHE.lock().unwrap();
        *cache = None;
        return get_audio_url(bvid);
    }
    if code != 0 {
        let msg = json["message"].as_str().unwrap_or("Unknown error");
        return Err(format!("Video info API error ({}): {}", code, msg));
    }

    let cid = json["data"]["cid"]
        .as_u64()
        .ok_or("No cid found for video")?;

    // Get the play URL with DASH format (fnval=16 → separate audio/video streams).
    let play_url = make_signed_url(
        "https://api.bilibili.com/x/player/playurl",
        &[
            ("bvid", bvid),
            ("cid", &cid.to_string()),
            ("fnval", "16"),    // DASH format
            ("fnver", "0"),
            ("fourk", "1"),
        ],
    )?;

    let json: serde_json::Value = fetch_json_with_retry(&play_url, "play URL")?;

    let code = json["code"].as_i64().unwrap_or(-1);
    if code == -799 {
        let mut cache = WBI_CACHE.lock().unwrap();
        *cache = None;
        return get_audio_url(bvid);
    }
    if code != 0 {
        let msg = json["message"].as_str().unwrap_or("Unknown error");
        return Err(format!("Play URL API error ({}): {}", code, msg));
    }

    // Get the highest quality audio stream from DASH.
    let dash = &json["data"]["dash"];
    let audio_streams = dash["audio"]
        .as_array()
        .ok_or("No DASH audio streams in response")?;

    if audio_streams.is_empty() {
        return Err("No audio stream available for this video".to_string());
    }

    // Pick the one with highest bandwidth.
    let mut best_bandwidth = 0u64;
    let mut best_url = String::new();

    for stream in audio_streams {
        let bw = stream["bandwidth"].as_u64().unwrap_or(0);
        if bw > best_bandwidth {
            best_bandwidth = bw;
            let url = stream["base_url"]
                .as_str()
                .or_else(|| stream["baseUrl"].as_str())
                .unwrap_or("");

            if url.is_empty() {
                // Try backup_url / backupUrl arrays.
                if let Some(backups) = stream["backup_url"]
                    .as_array()
                    .or_else(|| stream["backupUrl"].as_array())
                {
                    if let Some(first) = backups.first() {
                        best_url = first.as_str().unwrap_or("").to_string();
                    }
                }
                continue;
            }
            best_url = url.to_string();
        }
    }

    if best_url.is_empty() {
        return Err("Could not find a valid audio URL".to_string());
    }

    // Replace http with https.
    Ok(best_url.replace("http://", "https://"))
}

// ─── Audio Download ───────────────────────────────────

/// Download audio from a Bilibili video.
/// If `download_dir` is provided, saves there instead of temp.
/// Returns the path to the downloaded file.
pub fn download_online_audio(
    bvid: &str,
    download_dir: Option<&str>,
) -> Result<String, String> {
    let out_dir = match download_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::temp_dir().join("needmusic_online"),
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Cannot create dir: {}", e))?;

    // Check cache first.
    if let Some(cached) = find_cached_audio(&out_dir, bvid) {
        return Ok(cached.to_string_lossy().to_string());
    }

    // Get the audio stream URL.
    let audio_url = get_audio_url(bvid)?;

    // Determine file extension from the URL or default to m4a.
    let ext = if audio_url.contains(".m4a") || audio_url.contains("mp4a") {
        "m4a"
    } else if audio_url.contains(".opus") || audio_url.contains("opus") {
        "opus"
    } else if audio_url.contains(".mp3") || audio_url.contains("mpeg") {
        "mp3"
    } else {
        "m4a" // Default for Bilibili DASH audio.
    };

    let out_path = out_dir.join(format!("{}.{}", bvid, ext));

    // Download the file.
    let client = http_client();
    let mut resp = client
        .get(&audio_url)
        .header("Referer", "https://www.bilibili.com/")
        .header("Range", "bytes=0-")
        .send()
        .map_err(|e| format!("Audio download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Audio download HTTP {}", resp.status()));
    }

    let mut file = std::fs::File::create(&out_path)
        .map_err(|e| format!("Cannot create file: {}", e))?;

    resp.copy_to(&mut file)
        .map_err(|e| format!("Download write failed: {}", e))?;

    Ok(out_path.to_string_lossy().to_string())
}

fn find_cached_audio(dir: &Path, bvid: &str) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(bvid) {
                return Some(entry.path());
            }
        }
    }
    None
}

// ─── Availability check ──────────────────────────────

/// Check if yt-dlp is available on the system PATH.
pub fn is_ytdlp_available() -> bool {
    let mut cmd = Command::new("yt-dlp");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Find yt-dlp executable — tries yt-dlp first, then python -m yt_dlp, then auto-installs.
fn find_ytdlp() -> Result<Command, String> {
    if is_ytdlp_available() {
        let mut cmd = Command::new("yt-dlp");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        return Ok(cmd);
    }
    // Try python -m yt_dlp
    let mut probe = Command::new("python");
    #[cfg(target_os = "windows")]
    probe.creation_flags(0x08000000);
    let output = probe
        .args(["-m", "yt_dlp", "--version"])
        .output()
        .unwrap_or_else(|_| std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: vec![],
            stderr: vec![],
        });
    if output.status.success() {
        let mut cmd = Command::new("python");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        cmd.arg("-m").arg("yt_dlp")
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        return Ok(cmd);
    }

    // Auto-install: try pip install yt-dlp
    let mut install = Command::new("pip");
    #[cfg(target_os = "windows")]
    install.creation_flags(0x08000000);
    let result = install
        .args(["install", "yt-dlp", "--quiet", "--disable-pip-version-check"])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .output();

    if let Ok(out) = &result {
        if out.status.success() && is_ytdlp_available() {
            let mut cmd = Command::new("yt-dlp");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            cmd.stderr(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped());
            return Ok(cmd);
        }
    }

    // Also try pip3 / python -m pip as fallback
    for installer in &["pip3", "python"] {
        let args: &[&str] = if *installer == "python" {
            &["-m", "pip", "install", "yt-dlp", "--quiet", "--disable-pip-version-check"]
        } else {
            &["install", "yt-dlp", "--quiet", "--disable-pip-version-check"]
        };
        let mut cmd = Command::new(installer);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        if let Ok(out) = cmd.args(args)
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .output()
        {
            if out.status.success() && is_ytdlp_available() {
                let mut cmd = Command::new("yt-dlp");
                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000);
                cmd.stderr(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped());
                return Ok(cmd);
            }
        }
    }

    Err("yt-dlp could not be found or auto-installed. Install it manually: pip install yt-dlp".to_string())
}

// ─── YouTube Search ───────────────────────────────────

/// Search YouTube using yt-dlp's flat extraction.
/// Returns music-focused results by appending "music" / "audio" keywords.
pub fn search_youtube(query: &str) -> Result<OnlineSearchResult, String> {
    let _ytdlp = find_ytdlp()?;

    // yt-dlp "ytsearchN:query" format searches YouTube directly.
    let search_query = format!("ytsearch20:{} music audio", query);

    let output = run_ytdlp(
        &search_query,
        &[
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--no-check-certificate",
            "--socket-timeout", "15",
        ],
    )?;

    let mut results: Vec<OnlineTrackResult> = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            let id = json["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            let title = json["title"].as_str().unwrap_or("Unknown").to_string();
            let author = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();

            let duration_secs = json["duration"].as_f64().unwrap_or(0.0);
            let duration = fmt_secs(duration_secs);

            // YouTube flat-playlist returns "thumbnails" array, not "thumbnail" string.
            let cover_url = json["thumbnails"]
                .as_array()
                .and_then(|arr| {
                    // Pick the last (highest-res) thumbnail.
                    arr.last()
                        .and_then(|t| t["url"].as_str())
                })
                .or_else(|| json["thumbnail"].as_str())
                .unwrap_or("")
                .to_string();
            // If still empty, fall back to the standard YouTube thumbnail URL.
            let cover_url = if cover_url.is_empty() && !id.is_empty() {
                format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id)
            } else {
                cover_url
            };

            let description = json["description"]
                .as_str()
                .unwrap_or("")
                .to_string();

            let url = json["webpage_url"]
                .as_str()
                .or_else(|| json["url"].as_str())
                .unwrap_or("")
                .to_string();
            let url = if url.is_empty() {
                format!("https://www.youtube.com/watch?v={}", id)
            } else {
                url.to_string()
            };

            results.push(OnlineTrackResult {
                source: "youtube".to_string(),
                id: id.clone(),
                bvid: id, // re-use field for ID
                title,
                author,
                duration,
                duration_secs,
                cover_url,
                description,
                url,
            });
        }
    }

    let total = results.len() as u64;
    Ok(OnlineSearchResult { results, total })
}

/// Run yt-dlp with given arguments and return stdout as String.
fn run_ytdlp(query_or_url: &str, extra_args: &[&str]) -> Result<String, String> {
    let mut cmd = find_ytdlp()?;
    cmd.arg(query_or_url);
    for arg in extra_args {
        cmd.arg(arg);
    }

    let output = cmd.output().map_err(|e| format!("yt-dlp failed to start: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let err_msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("yt-dlp error: {}", err_msg));
    }

    Ok(stdout)
}

// ─── YouTube Audio Download ───────────────────────────

/// Download audio from a YouTube URL using yt-dlp.
/// Extracts best audio, converts to m4a.
pub fn download_youtube_audio(
    url: &str,
    download_dir: Option<&str>,
) -> Result<String, String> {
    let out_dir = match download_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::temp_dir().join("needmusic_online"),
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Cannot create dir: {}", e))?;

    // Build output template: %(id)s.%(ext)s in the target dir.
    let out_template = out_dir.join("%(id)s.%(ext)s");
    let out_template_str = out_template.to_string_lossy().to_string();

    run_ytdlp(
        url,
        &[
            "-f", "bestaudio[ext=m4a]/bestaudio/best",
            "--extract-audio",
            "--audio-format", "m4a",
            "--audio-quality", "0",
            "-o", &out_template_str,
            "--no-playlist",
            "--no-warnings",
            "--no-check-certificate",
            "--socket-timeout", "30",
            "-R", "3",           // retry 3 times
            "--fragment-retries", "3",
        ],
    )?;

    // Find the downloaded file (we use %(id)s in template, but yt-dlp may append
    // extra suffixes for some formats — look for any file starting with the video ID).
    // Actually yt-dlp uses the exact template; but extract-audio may change the ext.
    // Let's just scan the dir for the most recently created file matching our pattern.
    let downloaded = find_downloaded_file(&out_dir)
        .ok_or("Download completed but could not locate output file".to_string())?;

    Ok(downloaded.to_string_lossy().to_string())
}

/// Find the most recently modified file in a directory (the one yt-dlp just created).
fn find_downloaded_file(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, u64)> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(epoch) = modified.duration_since(std::time::UNIX_EPOCH) {
                            let secs = epoch.as_secs();
                            match &best {
                                None => best = Some((path, secs)),
                                Some((_, prev)) if secs > *prev => {
                                    best = Some((path, secs));
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

// ─── Unified Download (Bilibili or YouTube) ───────────

/// Download audio from either Bilibili (bvid) or YouTube (url).
/// `source` must be "bilibili" or "youtube".
pub fn download_online_audio_unified(
    source: &str,
    id_or_url: &str,
    download_dir: Option<&str>,
) -> Result<String, String> {
    match source {
        "youtube" => download_youtube_audio(id_or_url, download_dir),
        _ => download_online_audio(id_or_url, download_dir),
    }
}

// ─── Image Proxy ──────────────────────────────────────

/// Fetch an image URL and return as base64 data URI.
/// Adds Referer header for Bilibili CDN, works with any image URL.
pub fn proxy_image(url: &str) -> Result<String, String> {
    let client = http_client();
    let mut req = client.get(url);

    // Bilibili's CDN blocks requests without this referer.
    // YouTube and other sources work fine with or without it.
    if url.contains("hdslb.com") || url.contains("bilibili.com") {
        req = req.header("Referer", "https://www.bilibili.com/");
    }

    let resp = req
        .send()
        .map_err(|e| format!("Image fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Image fetch HTTP {}", resp.status()));
    }

    // Get content-type for the data URI.
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Image read failed: {}", e))?;

    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:{};base64,{}", content_type, b64))
}
