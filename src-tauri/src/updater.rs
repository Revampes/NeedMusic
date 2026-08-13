//! updater.rs — GitHub Releases update check + one-click installer download.
//!
//!   check_for_update()  → queries the latest GitHub release, compares with the
//!                         running version, and reports whether an update is
//!                         available (plus the installer download URL).
//!   download_update()   → downloads the installer .exe to a temp folder so the
//!                         frontend can launch it (one-click update).

use serde::Serialize;

/// The GitHub repo that publishes NeedMusic releases.
pub const UPDATE_REPO: &str = "Revampes/NeedMusic";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub download_url: Option<String>,
    pub notes: Option<String>,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("NeedMusic-Updater")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Query the latest GitHub release and compare it with the running version.
/// Failures (offline, rate-limited, no release yet) are returned as errors so
/// the UI can stay quiet instead of showing a broken banner.
pub fn check_for_update(current_version: &str) -> Result<UpdateInfo, String> {
    let client = http_client()?;
    let resp = client
        .get(format!("https://api.github.com/repos/{}/releases/latest", UPDATE_REPO))
        .send()
        .map_err(|e| format!("Failed to reach GitHub: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", resp.status().as_u16()));
    }
    let json: serde_json::Value = resp
        .json()
        .map_err(|e| format!("Invalid release response: {}", e))?;

    let tag = json["tag_name"].as_str().unwrap_or("");
    let latest_version = tag.trim_start_matches('v').to_string();
    let notes = json["body"].as_str().map(|s| s.to_string());

    // Pick the Windows installer asset (e.g. NeedMusic_Setup.exe).
    let download_url = json["assets"]
        .as_array()
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| {
                    let name = a["name"].as_str().unwrap_or("");
                    name.ends_with(".exe")
                        && (name.contains("Setup") || name.contains("setup") || name.contains("install"))
                })
                .and_then(|a| a["browser_download_url"].as_str().map(|s| s.to_string()))
        });

    let update_available = !latest_version.is_empty() && version_greater(&latest_version, current_version);

    Ok(UpdateInfo {
        update_available,
        current_version: current_version.to_string(),
        latest_version,
        download_url,
        notes,
    })
}

/// Download the installer to a temp folder and return its local path.
pub fn download_update(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("NeedMusic-Updater")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download returned HTTP {}", resp.status().as_u16()));
    }

    let fname = url.rsplit('/').next().unwrap_or("NeedMusic_Setup.exe");
    let dir = std::env::temp_dir().join("needmusic-updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp folder: {}", e))?;
    let path = dir.join(sanitize_filename(fname));

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Failed to read download: {}", e))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write installer: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Numeric three-part comparison ("1.2.3" vs "1.2.10" → 1.2.10 is newer).
/// Tolerates leading "v", dashes, and missing parts.
fn version_greater(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split(|c: char| !c.is_ascii_digit())
            .filter_map(|p| p.parse::<u64>().ok())
            .take(4)
            .collect()
    };
    let l = parse(latest);
    let c = parse(current);
    for i in 0..l.len().max(c.len()) {
        let lv = l.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if lv != cv {
            return lv > cv;
        }
    }
    false
}

/// Keep only safe filename characters.
fn sanitize_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if !clean.chars().any(|c| c.is_alphanumeric()) {
        "NeedMusic_Setup.exe".to_string()
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert!(version_greater("1.1.0", "1.0.0"));
        assert!(version_greater("1.1.0", "1.0.9"));
        assert!(version_greater("2.0.0", "1.9.9"));
        assert!(version_greater("1.2.10", "1.2.9"));
        assert!(!version_greater("1.0.0", "1.0.0"));
        assert!(!version_greater("1.0.0", "1.1.0"));
        assert!(!version_greater("", "1.0.0"));
    }

    #[test]
    fn filename_sanitizing() {
        assert_eq!(sanitize_filename("NeedMusic_Setup.exe"), "NeedMusic_Setup.exe");
        assert_eq!(sanitize_filename("../evil/..exe"), ".._evil_..exe");
        assert_eq!(sanitize_filename("///"), "NeedMusic_Setup.exe");
    }
}
