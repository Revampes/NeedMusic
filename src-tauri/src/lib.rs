use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State, Emitter, WebviewUrl,
};
use std::sync::Mutex;
use std::time::Duration;

mod scanner;
mod concurrency;
mod audio;
mod discord_rpc;
mod online;

pub use scanner::LibraryScanner;
pub use concurrency::ConcurrencyGate;
pub use audio::NativeAudioPlayer;
pub use discord_rpc::DiscordRpcManager;
pub use online::{OnlineTrackResult, OnlineSearchResult};

pub struct AppState {
    pub scanner: Mutex<LibraryScanner>,
    pub scan_status: Mutex<ScanStatus>,
    pub is_playing: Mutex<bool>,
    pub close_to_tray: Mutex<bool>,
    pub audio: NativeAudioPlayer,
    pub discord_rpc: DiscordRpcManager,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanStatus {
    pub is_scanning: bool,
    pub progress: f32,
    pub total_files: u64,
    pub processed_files: u64,
    pub current_directory: String,
}

impl Default for ScanStatus {
    fn default() -> Self {
        Self {
            is_scanning: false,
            progress: 0.0,
            total_files: 0,
            processed_files: 0,
            current_directory: String::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackMetadata {
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub duration_secs: f64,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub genre: String,
    pub year: Option<i32>,
    pub has_artwork: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanResult {
    pub tracks: Vec<TrackMetadata>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaAction {
    Play,
    Pause,
    PlayPause,
    Next,
    Previous,
    Stop,
}

// ─── Tauri Commands ──────────────────────────────────────

#[tauri::command]
async fn scan_directory(
    path: String,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let concurrency_gate = ConcurrencyGate::new(4);
    let result = {
        let mut scanner = state.scanner.lock().map_err(|e| e.to_string())?;
        scanner.scan(&path, &concurrency_gate).map_err(|e| e.to_string())?
    };
    Ok(result)
}

#[tauri::command]
async fn get_scan_status(state: State<'_, AppState>) -> Result<ScanStatus, String> {
    let status = state.scan_status.lock().map_err(|e| e.to_string())?;
    Ok(status.clone())
}

#[tauri::command]
async fn read_metadata(file_path: String) -> Result<TrackMetadata, String> {
    scanner::parse_metadata(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn extract_artwork(file_path: String) -> Result<Option<String>, String> {
    scanner::extract_artwork_to_temp(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_playback_state(is_playing: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut p = state.is_playing.lock().map_err(|e| e.to_string())?;
    *p = is_playing;
    Ok(())
}

/// Read an audio file from disk and return it as base64-encoded data URL.
#[tauri::command]
async fn read_audio_file(file_path: String) -> Result<String, String> {
    use base64::Engine;
    let data = std::fs::read(&file_path).map_err(|e| format!("Read error: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    // Determine MIME type from extension.
    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");
    let mime = match ext.to_lowercase().as_str() {
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "ogg" => "audio/ogg",
        "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "wma" => "audio/x-ms-wma",
        "aiff" => "audio/aiff",
        _ => "audio/mpeg",
    };
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// Toggle auto-start on Windows via registry.
/// In debug mode also builds the frontend so standalone launch works.
#[tauri::command]
async fn set_autostart(enable: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().unwrap_or_else(|| std::path::Path::new("."));
    let path = exe.to_string_lossy().to_string();

    if enable {
        // In debug mode, ensure frontend dist exists so standalone launch works.
        #[cfg(debug_assertions)]
        {
            // Try to locate the project root (where package.json lives).
            // The debug exe is at: src-tauri/target/debug/needmusic.exe
            // Project root is 3 levels up.
            let project_root = exe_dir.join("..").join("..").join("..");
            let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
            let build = std::process::Command::new(npm)
                .args(["run", "build"])
                .current_dir(&project_root)
                .output();
            if let Err(ref e) = build {
                eprintln!("[NeedMusic] autostart: npm run build failed: {}. Autostart may not work until you build manually.", e);
            }
        }

        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let name = "NeedMusic";
        std::process::Command::new("reg")
            .args(["add", key, "/v", name, "/t", "REG_SZ", "/d", &path, "/f"])
            .output()
            .map_err(|e| e.to_string())?;
    } else {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let name = "NeedMusic";
        std::process::Command::new("reg")
            .args(["delete", key, "/v", name, "/f"])
            .output()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Set whether close button hides to tray instead of quitting.
#[tauri::command]
async fn set_close_to_tray(
    enable: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut c = state.close_to_tray.lock().map_err(|e| e.to_string())?;
    *c = enable;
    Ok(())
}

// ─── Native Audio Commands ──────────────────────────

#[tauri::command]
async fn play_audio(file_path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.audio.play(&file_path)
}

#[tauri::command]
async fn pause_audio(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.pause()
}

#[tauri::command]
async fn resume_audio(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.resume()
}

#[tauri::command]
async fn stop_audio(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.stop()
}

#[tauri::command]
async fn seek_audio(secs: f64, state: State<'_, AppState>) -> Result<(), String> {
    state.audio.seek(secs)
}

#[tauri::command]
async fn set_audio_volume(volume: f32, state: State<'_, AppState>) -> Result<(), String> {
    state.audio.set_volume(volume)
}

#[tauri::command]
async fn is_audio_playing(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.audio.is_playing())
}

#[tauri::command]
async fn get_audio_duration(state: State<'_, AppState>) -> Result<f64, String> {
    Ok(state.audio.get_duration())
}

#[tauri::command]
async fn is_audio_sink_empty(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.audio.is_sink_empty())
}

/// Apply native window blur. blur=0 means clear, blur>0 means apply.
#[tauri::command]
async fn set_window_blur(blur: u8, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        {
            if blur == 0 {
                let _ = window_vibrancy::clear_blur(&w);
            } else {
                let _ = window_vibrancy::apply_blur(&w, None);
            }
        }
    }
    Ok(())
}

// ─── Dynamic Island Window Management ──────────────────

/// Toggle the Dynamic Island floating overlay window.
#[tauri::command]
async fn toggle_dynamic_island(
    enable: bool,
    always_on_top: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if enable {
        // Check if window already exists
        if app.get_webview_window("dynamic-island").is_some() {
            // Just show it and update always-on-top
            if let Some(w) = app.get_webview_window("dynamic-island") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.set_always_on_top(always_on_top);
            }
            return Ok(());
        }

        use tauri::WebviewWindowBuilder;

        // Determine URL – use dev server when available, otherwise bundled assets.
        let url = if is_dev_server_running() {
            WebviewUrl::External("http://localhost:1420/dynamic-island.html".parse().unwrap())
        } else {
            WebviewUrl::App("dynamic-island.html".into())
        };

        let window = WebviewWindowBuilder::new(&app, "dynamic-island", url)
            .title("NeedMusic — Dynamic Island")
            .inner_size(340.0, 200.0)
            .min_inner_size(260.0, 120.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(always_on_top)
            .skip_taskbar(true)
            .visible(true)
            .build()
            .map_err(|e| format!("Failed to create Dynamic Island window: {}", e))?;

        // Position at top-right area of the screen
        if let Ok(Some(monitor)) = window.current_monitor() {
            let size = monitor.size();
            let _ = window.set_position(tauri::PhysicalPosition::new(
                (size.width as f64 * 0.75) as i32,
                20,
            ));
        }

        Ok(())
    } else {
        // Close/hide the window
        if let Some(w) = app.get_webview_window("dynamic-island") {
            let _ = w.close();
        }
        Ok(())
    }
}

/// Update dynamic island always-on-top setting without toggling visibility.
#[tauri::command]
async fn set_island_always_on_top(
    always_on_top: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("dynamic-island") {
        let _ = w.set_always_on_top(always_on_top);
    }
    Ok(())
}

// ─── Discord Rich Presence Commands ──────────────────

#[tauri::command]
async fn enable_discord_rpc(
    app: tauri::AppHandle,
) -> Result<(), String> {
    // spawn_blocking keeps the blocking IPC I/O off the async runtime.
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.discord_rpc.enable()
    })
    .await
    .map_err(|e| format!("Discord RPC enable panicked: {}", e))?
}

#[tauri::command]
async fn disable_discord_rpc(
    app: tauri::AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.discord_rpc.disable()
    })
    .await
    .map_err(|e| format!("Discord RPC disable panicked: {}", e))?
}

#[tauri::command]
async fn is_discord_rpc_enabled(
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    Ok(state.discord_rpc.is_enabled())
}

#[tauri::command]
async fn update_discord_presence(
    title: String,
    artist: String,
    album: String,
    is_playing: bool,
    position_secs: f64,
    duration_secs: f64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.discord_rpc.update_presence(
            &title,
            &artist,
            &album,
            is_playing,
            position_secs,
            duration_secs,
        )
    })
    .await
    .map_err(|e| format!("Discord RPC update panicked: {}", e))?
}

#[tauri::command]
async fn clear_discord_presence(
    app: tauri::AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.discord_rpc.clear_presence()
    })
    .await
    .map_err(|e| format!("Discord RPC clear panicked: {}", e))?
}

/// Send a keep-alive heartbeat to Discord to prevent pipe timeout.
/// The frontend should call this periodically (every ~15 seconds).
#[tauri::command]
async fn heartbeat_discord_rpc(
    app: tauri::AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.discord_rpc.heartbeat()
    })
    .await
    .map_err(|e| format!("Discord RPC heartbeat panicked: {}", e))?
}

// ─── Online / Bilibili Commands ─────────────────────────

#[tauri::command]
async fn search_bilibili(query: String) -> Result<OnlineSearchResult, String> {
    let q = query.clone();
    tokio::task::spawn_blocking(move || online::search_bilibili(&q))
        .await
        .map_err(|e| format!("Search task panicked: {}", e))?
}

#[tauri::command]
async fn download_online_audio(
    bvid: String,
    download_dir: Option<String>,
) -> Result<String, String> {
    let b = bvid.clone();
    let d = download_dir.clone();
    tokio::task::spawn_blocking(move || {
        online::download_online_audio(&b, d.as_deref())
    })
    .await
    .map_err(|e| format!("Download task panicked: {}", e))?
}

#[tauri::command]
async fn is_ytdlp_available() -> Result<bool, String> {
    Ok(online::is_ytdlp_available())
}

#[tauri::command]
async fn proxy_image(url: String) -> Result<String, String> {
    let u = url.clone();
    tokio::task::spawn_blocking(move || online::proxy_image(&u))
        .await
        .map_err(|e| format!("Image proxy panicked: {}", e))?
}

// ─── Cache Management ─────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheInfo {
    pub size_bytes: u64,
    pub size_mb: f64,
    pub file_count: u64,
    pub cache_dir: String,
}

#[tauri::command]
async fn get_online_cache_info() -> Result<CacheInfo, String> {
    let cache_dir = std::env::temp_dir().join("needmusic_online");
    let mut total_size: u64 = 0;
    let mut file_count: u64 = 0;

    if cache_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        total_size += meta.len();
                        file_count += 1;
                    }
                }
            }
        }
    }

    Ok(CacheInfo {
        size_bytes: total_size,
        size_mb: total_size as f64 / (1024.0 * 1024.0),
        file_count,
        cache_dir: cache_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn clear_online_cache() -> Result<(), String> {
    let cache_dir = std::env::temp_dir().join("needmusic_online");
    if cache_dir.exists() {
        std::fs::remove_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to clear cache: {}", e))?;
    }
    Ok(())
}

// ─── Dev Server Detection ───────────────────────────────

/// Quick check if the Vite dev server is accepting connections.
fn is_dev_server_running() -> bool {
    // Only meaningful in debug builds.
    if cfg!(debug_assertions) {
        std::net::TcpStream::connect_timeout(
            &"127.0.0.1:1420".parse().unwrap(),
            Duration::from_millis(200),
        )
        .is_ok()
    } else {
        false
    }
}

// ─── Application Entry ───────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // ── System Tray ──────────────────────────────────
            let show_item = MenuItemBuilder::with_id("show", "Show NeedMusic")
                .build(app)?;
            let playpause_item = MenuItemBuilder::with_id("playpause", "Play / Pause")
                .build(app)?;
            let next_item = MenuItemBuilder::with_id("next", "Next Track")
                .build(app)?;
            let prev_item = MenuItemBuilder::with_id("previous", "Previous Track")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&playpause_item)
                .item(&next_item)
                .item(&prev_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("NeedMusic")
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref();
                    match id {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "playpause" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("media-action", MediaAction::PlayPause);
                            }
                        }
                        "next" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("media-action", MediaAction::Next);
                            }
                        }
                        "previous" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("media-action", MediaAction::Previous);
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── Global Media Shortcuts ───────────────────────
            use tauri_plugin_global_shortcut::{
                GlobalShortcutExt, ShortcutState,
            };

            let handle = app.handle().clone();
            let media_keys = ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaStop"];

            for key in &media_keys {
                let h = handle.clone();
                let k = *key;
                let action = match k {
                    "MediaPlayPause" => MediaAction::PlayPause,
                    "MediaTrackNext" => MediaAction::Next,
                    "MediaTrackPrevious" => MediaAction::Previous,
                    "MediaStop" => MediaAction::Stop,
                    _ => continue,
                };
                if let Err(e) = app.global_shortcut().on_shortcut(k, move |_app, _s, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = h.get_webview_window("main") {
                            let _ = window.emit("media-action", action.clone());
                        }
                    }
                }) {
                    eprintln!("[NeedMusic] Shortcut {}: {}", k, e);
                }
            }

            // ── Close-to-tray: hide instead of closing ──────
            let window = app.get_webview_window("main").unwrap();

            // ── Dev-server HMR redirect ─────────────────────
            // If the Vite dev server is running, navigate to it for hot-reload.
            // Otherwise stay on the built frontend (e.g. auto-start scenario).
            if is_dev_server_running() {
                let _ = window.eval("window.location.replace('http://localhost:1420')");
            }

            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Read the close-to-tray setting from app state.
                    let should_hide = handle
                        .try_state::<AppState>()
                        .and_then(|s| s.close_to_tray.lock().ok().map(|c| *c))
                        .unwrap_or(false);

                    if should_hide {
                        // Prevent actual close, hide to tray instead.
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    // else: allow the window to close normally (app will exit)
                }
            });

            // ── App State ────────────────────────────────────
            // Create native audio output (OutputStream must be kept alive
            // for the lifetime of the app but is NOT Send — so we leak it).
            let (audio_stream, stream_handle) =
                rodio::OutputStream::try_default()
                    .expect("Failed to open audio output device");
            // Leak the stream so it lives forever (app lifetime).
            std::mem::forget(audio_stream);

            let audio_player = NativeAudioPlayer::new(stream_handle);

            let discord_rpc = DiscordRpcManager::new("1519532803811704953".to_string());

            app.manage(AppState {
                scanner: Mutex::new(LibraryScanner::new()),
                scan_status: Mutex::new(ScanStatus::default()),
                is_playing: Mutex::new(false),
                close_to_tray: Mutex::new(true),  // default: hide to tray
                audio: audio_player,
                discord_rpc,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            get_scan_status,
            read_metadata,
            extract_artwork,
            set_playback_state,
            read_audio_file,
            set_autostart,
            set_close_to_tray,
            set_window_blur,
            toggle_dynamic_island,
            set_island_always_on_top,
            play_audio,
            pause_audio,
            resume_audio,
            stop_audio,
            seek_audio,
            set_audio_volume,
            is_audio_playing,
            get_audio_duration,
            is_audio_sink_empty,
            enable_discord_rpc,
            disable_discord_rpc,
            is_discord_rpc_enabled,
            update_discord_presence,
            clear_discord_presence,
            heartbeat_discord_rpc,
            search_bilibili,
            download_online_audio,
            is_ytdlp_available,
            proxy_image,
            get_online_cache_info,
            clear_online_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NeedMusic");
}
