/// DiscordRpcManager — manages the Discord Rich Presence connection
/// via raw IPC (named pipes on Windows, Unix sockets on macOS/Linux).
///
/// Communicates with the local Discord client to show
/// "Listening to NeedMusic" on the user's Discord profile.
///
/// The Discord RPC protocol is a simple JSON frame protocol:
///   1. Connect to the IPC endpoint (pipes 0-9)
///   2. Send handshake (op 0) with client ID
///   3. Send activity updates (op 1, cmd: SET_ACTIVITY)
///
/// This uses raw IPC instead of the `discord-rich-presence` crate
/// to guarantee Send + Sync compatibility with Tauri's thread pool.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long to wait for a single IPC read/write before timing out.
/// (Only used on Unix; Windows named pipes use spawn_blocking isolation.)
#[cfg_attr(windows, allow(dead_code))]
const IPC_TIMEOUT: Duration = Duration::from_secs(3);

/// How often to ping Discord to keep the pipe alive (heartbeat).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// Holds the current Discord Rich Presence connection and state.
/// All fields are Send + Sync so this can be stored in Tauri's managed state.
pub struct DiscordRpcManager {
    /// The raw IPC connection (None = not connected).
    connection: Mutex<Option<IpcConnection>>,
    /// Whether the user has enabled Discord Rich Presence.
    enabled: Mutex<bool>,
    /// The Discord Application ID.
    app_id: String,
    /// Track whether we're currently connected.
    connected: Mutex<bool>,
    /// When we last sent a heartbeat (ping) to Discord.
    last_heartbeat: Mutex<Instant>,
}

/// Abstracts over platform-specific IPC transport.
enum IpcConnection {
    #[cfg(windows)]
    Windows(std::fs::File),
    #[cfg(not(windows))]
    Unix(std::os::unix::net::UnixStream),
}

// ─── IPC I/O helpers ──────────────────────────────────

fn ipc_read_exact(conn: &mut IpcConnection, buf: &mut [u8]) -> Result<(), String> {
    match conn {
        #[cfg(windows)]
        IpcConnection::Windows(f) => {
            f.read_exact(buf).map_err(|e| format!("IPC read: {}", e))
        }
        #[cfg(not(windows))]
        IpcConnection::Unix(s) => {
            s.set_read_timeout(Some(IPC_TIMEOUT))
                .map_err(|e| format!("set_read_timeout: {}", e))?;
            s.read_exact(buf).map_err(|e| format!("IPC read: {}", e))
        }
    }
}

fn ipc_write_all(conn: &mut IpcConnection, data: &[u8]) -> Result<(), String> {
    match conn {
        #[cfg(windows)]
        IpcConnection::Windows(f) => {
            f.write_all(data).map_err(|e| format!("IPC write: {}", e))?;
            f.flush().map_err(|e| format!("IPC flush: {}", e))?;
        }
        #[cfg(not(windows))]
        IpcConnection::Unix(s) => {
            s.set_write_timeout(Some(IPC_TIMEOUT))
                .map_err(|e| format!("set_write_timeout: {}", e))?;
            s.write_all(data).map_err(|e| format!("IPC write: {}", e))?;
            s.flush().map_err(|e| format!("IPC flush: {}", e))?;
        }
    }
    Ok(())
}

// ─── DiscordRpcManager ────────────────────────────────

impl DiscordRpcManager {
    pub fn new(app_id: String) -> Self {
        Self {
            connection: Mutex::new(None),
            enabled: Mutex::new(false),
            app_id,
            connected: Mutex::new(false),
            last_heartbeat: Mutex::new(Instant::now()),
        }
    }

    pub fn enable(&self) -> Result<(), String> {
        *self.enabled.lock().map_err(|e| e.to_string())? = true;
        match self.connect() {
            Ok(()) => {
                eprintln!("[DiscordRpc] Connected successfully");
                // Initialize heartbeat timestamp.
                if let Ok(mut hb) = self.last_heartbeat.lock() {
                    *hb = Instant::now();
                }
                Ok(())
            }
            Err(e) => {
                // Rollback — don't leave enabled=true with no connection.
                *self.enabled.lock().map_err(|e2| e2.to_string())? = false;
                eprintln!("[DiscordRpc] Enable failed: {}", e);
                Err(format!("Discord RPC: {}. Is Discord running?", e))
            }
        }
    }

    pub fn disable(&self) -> Result<(), String> {
        let mut enabled = self.enabled.lock().map_err(|e| e.to_string())?;
        *enabled = false;
        drop(enabled);
        self.disconnect()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.lock().ok().map(|e| *e).unwrap_or(false)
    }

    /// Send a heartbeat (ping) to Discord to keep the pipe alive.
    /// Should be called periodically (every ~10s) from the frontend
    /// or from update_presence as a side-effect.
    pub fn heartbeat(&self) -> Result<(), String> {
        if !self.is_enabled() || !self.is_connected() {
            return Ok(());
        }

        // Check if enough time has passed since last heartbeat.
        {
            let hb = self.last_heartbeat.lock().map_err(|e| e.to_string())?;
            if hb.elapsed() < HEARTBEAT_INTERVAL {
                return Ok(());
            }
        }

        let payload = json!({
            "cmd": "PING",
            "args": {},
            "nonce": format!("hb-{}", SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs())
        });

        match self.send_frame(1, &payload) {
            Ok(()) => {
                if let Ok(mut hb) = self.last_heartbeat.lock() {
                    *hb = Instant::now();
                }
                Ok(())
            }
            Err(e) => {
                eprintln!("[DiscordRpc] Heartbeat failed: {}", e);
                Err(e)
            }
        }
    }

    pub fn update_presence(
        &self,
        title: &str,
        artist: &str,
        album: &str,
        is_playing: bool,
        position_secs: f64,
        duration_secs: f64,
    ) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }
        if !self.is_connected() {
            // Try to reconnect before sending the update.
            match self.connect() {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("[DiscordRpc] Reconnect failed: {}", e);
                    return Err(e);
                }
            }
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let mut activity = json!({
            "details": title,
            "state": format!("by {}", artist),
            "assets": {
                "large_image": "needmusic_logo",
                "large_text": album,
                "small_image": if is_playing { "play" } else { "pause" },
                "small_text": if is_playing { "Playing" } else { "Paused" }
            }
        });

        if duration_secs > 0.0 && is_playing {
            let start_ts = now - (position_secs as i64);
            let end_ts = start_ts + (duration_secs as i64);
            activity["timestamps"] = json!({
                "start": start_ts,
                "end": end_ts
            });
        }

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {
                "pid": std::process::id(),
                "activity": activity
            },
            "nonce": format!("{}", now)
        });

        // Attempt to send. If the pipe is broken, auto-reconnect and retry once.
        match self.send_frame(1, &payload) {
            Ok(()) => {
                // Also send a heartbeat as a side-effect if due.
                let _ = self.heartbeat();
                Ok(())
            }
            Err(e) => {
                eprintln!("[DiscordRpc] Send failed, attempting reconnect: {}", e);
                // Try to reconnect and retry.
                match self.connect() {
                    Ok(()) => {
                        eprintln!("[DiscordRpc] Reconnected, retrying send");
                        self.send_frame(1, &payload)
                    }
                    Err(reconnect_err) => {
                        eprintln!("[DiscordRpc] Reconnect also failed: {}", reconnect_err);
                        Err(reconnect_err)
                    }
                }
            }
        }
    }

    pub fn clear_presence(&self) -> Result<(), String> {
        if !self.is_connected() {
            return Ok(());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {
                "pid": std::process::id(),
                "activity": null
            },
            "nonce": format!("{}", now)
        });
        self.send_frame(1, &payload)
    }

    // ─── Private helpers ──────────────────────────────

    fn is_connected(&self) -> bool {
        self.connected.lock().ok().map(|c| *c).unwrap_or(false)
    }

    fn connect(&self) -> Result<(), String> {
        self.disconnect_inner();

        let mut conn = None;
        for i in 0..10 {
            match Self::try_connect_pipe(i) {
                Ok(c) => {
                    eprintln!("[DiscordRpc] Connected to pipe {}", i);
                    conn = Some(c);
                    break;
                }
                Err(e) => {
                    eprintln!("[DiscordRpc] Pipe {}: {}", i, e);
                    continue;
                }
            }
        }
        let mut conn = conn.ok_or_else(|| {
            "Discord is not running or Rich Presence is unavailable".to_string()
        })?;

        // ── Handshake (opcode 0) ──
        let handshake = json!({ "v": 1, "client_id": self.app_id });
        let hs_str = handshake.to_string();
        let mut frame = Vec::new();
        frame.extend_from_slice(&0u32.to_le_bytes());
        frame.extend_from_slice(&(hs_str.len() as u32).to_le_bytes());
        frame.extend_from_slice(hs_str.as_bytes());
        ipc_write_all(&mut conn, &frame)?;

        // Read handshake response to confirm connection (with timeout).
        match Self::read_frame(&mut conn) {
            Ok(resp) => eprintln!("[DiscordRpc] Handshake response: {}", &resp[..resp.len().min(200)]),
            Err(e) => {
                eprintln!("[DiscordRpc] Handshake read failed: {}", e);
                return Err(format!("Handshake failed: {}. Is Discord running?", e));
            }
        }

        let mut conn_guard = self.connection.lock().map_err(|e| e.to_string())?;
        *conn_guard = Some(conn);
        drop(conn_guard);
        *self.connected.lock().map_err(|e| e.to_string())? = true;

        Ok(())
    }

    fn disconnect(&self) -> Result<(), String> {
        self.disconnect_inner();
        Ok(())
    }

    fn disconnect_inner(&self) {
        if let Ok(mut g) = self.connection.lock() { *g = None; }
        if let Ok(mut g) = self.connected.lock() { *g = false; }
    }

    fn send_frame(&self, opcode: u32, payload: &Value) -> Result<(), String> {
        let mut conn_guard = self.connection.lock().map_err(|e| e.to_string())?;
        let conn = conn_guard.as_mut()
            .ok_or_else(|| "Not connected to Discord".to_string())?;

        let payload_str = payload.to_string();
        eprintln!("[DiscordRpc] Sending: {}", &payload_str[..payload_str.len().min(300)]);

        let mut frame = Vec::new();
        frame.extend_from_slice(&opcode.to_le_bytes());
        frame.extend_from_slice(&(payload_str.len() as u32).to_le_bytes());
        frame.extend_from_slice(payload_str.as_bytes());
        ipc_write_all(conn, &frame)?;

        // Read response to keep pipe healthy.
        match Self::read_frame(conn) {
            Ok(resp) => {
                eprintln!("[DiscordRpc] Response: {}", &resp[..resp.len().min(200)]);
                Ok(())
            }
            Err(e) => {
                eprintln!("[DiscordRpc] Response read failed (pipe may be closed): {}", e);
                drop(conn_guard);
                self.disconnect_inner();
                Err(format!("Discord IPC lost: {}", e))
            }
        }
    }

    fn read_frame(conn: &mut IpcConnection) -> Result<String, String> {
        let mut header = [0u8; 8];
        ipc_read_exact(conn, &mut header)?;
        let _opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        if length > 65536 {
            return Err(format!("Frame too large: {} bytes", length));
        }
        let mut payload = vec![0u8; length];
        ipc_read_exact(conn, &mut payload)?;
        String::from_utf8(payload).map_err(|e| format!("UTF-8: {}", e))
    }

    fn try_connect_pipe(pipe_num: u32) -> Result<IpcConnection, String> {
        #[cfg(windows)]
        {
            let pipe_path = format!(r"\\.\pipe\discord-ipc-{}", pipe_num);
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe_path)
                .map_err(|_| format!("pipe {}", pipe_num))?;
            Ok(IpcConnection::Windows(file))
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::net::UnixStream;
            let sock_path = if let Ok(d) = std::env::var("XDG_RUNTIME_DIR") {
                format!("{}/discord-ipc-{}", d, pipe_num)
            } else if let Ok(d) = std::env::var("TMPDIR") {
                format!("{}/discord-ipc-{}", d, pipe_num)
            } else {
                format!("/tmp/discord-ipc-{}", pipe_num)
            };
            let stream = UnixStream::connect(&sock_path)
                .map_err(|_| format!("sock {}", pipe_num))?;
            Ok(IpcConnection::Unix(stream))
        }
    }
}

impl Drop for DiscordRpcManager {
    fn drop(&mut self) {
        self.disconnect_inner();
    }
}

