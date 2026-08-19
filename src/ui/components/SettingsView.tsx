import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { LibraryManager } from "@core/services/LibraryManager";
import { DiscordRpcService } from "@core/services/DiscordRpcService";
import { OnlineMusicService } from "@core/services/OnlineMusicService";
import { Track } from "@core/models/Track";
import { IconFolder, IconVolume, IconPalette, IconSettings, IconRocket, IconCheck, IconAlert } from "@ui/components/Icons";
import EqSettings from "@ui/components/EqSettings";
import HotkeySettings from "@ui/components/HotkeySettings";

interface Props { onTracksLoaded: (tracks: Track[]) => void; }
type Settings = Record<string, string>;

interface CacheInfo {
  size_bytes: number;
  size_mb: number;
  file_count: number;
  cache_dir: string;
}

const DEFAULTS: Settings = {
  autoScan: "false", autoScanPath: "", scanFolderPath: "",
  crossfade: "0", gapless: "true",
  blurIntensity: "14", panelOpacity: "50", themeAccent: "#e94560", backgroundStyle: "dark",
  // Custom style
  customBgImage: "", customBgColor: "#1a1a2e", customBgBlur: "0", customBgIntensity: "80",
  customBgGradientStart: "#1a1a2e", customBgGradientEnd: "#16213e", customBgGradientAngle: "135",
  minimizeToTray: "true", closeToTray: "true", autoStart: "false", gamingDetect: "false",
  discordRpc: "false",
  // Dynamic Island
  dynIslandEnabled: "false", dynIslandAlwaysOnTop: "true",
  dynIslandColor: "#1a1a2e", dynIslandBlur: "20", dynIslandSize: "300",
  dynIslandOpacity: "85", dynIslandLyrics: "false",
  // Cache
  maxCacheMb: "500",
  // Online Search
  youtubeSearch: "false",
  onlineDownloadPath: "",
};

const BACKGROUND_STYLES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "glass", label: "Glass" },
  { value: "custom", label: "Custom" },
];

const SettingsView: React.FC<Props> = ({ onTracksLoaded }) => {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ type: "success" | "error" | "debug"; text: string } | null>(null);
  const [debugScanning, setDebugScanning] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [ytDlpAvailable, setYtDlpAvailable] = useState(false);
  const [downloadPath, setDownloadPath] = useState("");
  // LAN Sync (experimental)
  const [lanUrl, setLanUrl] = useState("");
  const [lanBusy, setLanBusy] = useState(false);
  const [lanError, setLanError] = useState<string | null>(null);
  // Convert saved audio to MP3
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertResult, setConvertResult] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const bgImageInputRef = useRef<HTMLInputElement>(null);
  const db = DatabaseManager.getInstance();

  useEffect(() => { (async () => {
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) { const v = await db.getSetting(k); if (v !== null) s[k] = v; }
    setSettings(s);
    const sp = await db.getSetting("scanFolderPath"); if (sp) setScanPath(sp);
    // Restore appearance
    applyAllStyles(s);
    // Reflect the auto-started LAN server (if running).
    try { const u = await invoke<string>("lan_server_url"); if (u) setLanUrl(u); } catch { /* not running */ }
  })(); }, [db]);

  // Load cache info
  const loadCacheInfo = useCallback(async () => {
    try {
      const info = await invoke<CacheInfo>("get_online_cache_info");
      setCacheInfo(info);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadCacheInfo(); }, [loadCacheInfo]);

  // Check yt-dlp availability
  useEffect(() => {
    (async () => {
      const avail = await OnlineMusicService.getInstance().isYtDlpAvailable();
      setYtDlpAvailable(avail);
    })();
  }, []);

  // Load download path
  useEffect(() => {
    (async () => {
      let dir = await db.getSetting("onlineDownloadPath");
      if (!dir) {
        try {
          dir = await invoke<string>("get_default_download_dir");
        } catch { dir = ""; }
      }
      setDownloadPath(dir || "");
    })();
  }, [db]);

  const handleClearCache = useCallback(async () => {
    setClearingCache(true);
    try {
      await invoke("clear_online_cache");
      await loadCacheInfo();
    } catch (e) {
      setScanResult({ type: "error", text: String(e) });
    }
    setClearingCache(false);
  }, [loadCacheInfo]);

  const save = useCallback(async (k: string, v: string) => {
    setSettings(p => ({ ...p, [k]: v })); await db.setSetting(k, v);
  }, [db]);

  const applyAllStyles = (s: Settings) => {
    const h = document.documentElement;
    // Remove all theme classes
    h.classList.remove("theme-dark", "theme-light", "theme-glass", "theme-custom");
    // Clean up glass opacity classes from any previous glass mode
    for (let i = 0; i <= 100; i += 10) h.classList.remove(`glass-opacity-${i}`);
    // Apply selected theme
    const style = s.backgroundStyle || "dark";
    h.classList.add(`theme-${style}`);
    h.style.setProperty("--bg-style", style);

    // Blur
    if (s.blurIntensity) h.style.setProperty("--glass-blur", `${s.blurIntensity}px`);
    // Accent
    if (s.themeAccent) h.style.setProperty("--accent-primary", s.themeAccent);

    // Custom style
    if (style === "custom") {
      if (s.customBgColor) h.style.setProperty("--custom-bg-color", s.customBgColor);
      if (s.customBgBlur) h.style.setProperty("--custom-bg-blur", `${s.customBgBlur}px`);
      if (s.customBgIntensity) h.style.setProperty("--custom-bg-intensity", `${Number(s.customBgIntensity) / 100}`);
      if (s.customBgGradientStart) h.style.setProperty("--custom-bg-grad-start", s.customBgGradientStart);
      if (s.customBgGradientEnd) h.style.setProperty("--custom-bg-grad-end", s.customBgGradientEnd);
      if (s.customBgGradientAngle) h.style.setProperty("--custom-bg-grad-angle", `${s.customBgGradientAngle}deg`);
      if (s.customBgImage) {
        h.style.setProperty("--custom-bg-image", `url(${s.customBgImage})`);
      } else {
        h.style.setProperty("--custom-bg-image", "none");
      }
    }

    // Glass opacity
    if (style === "glass") {
      const val = Math.round(Number(s.panelOpacity || "50") / 10) * 10;
      h.classList.add(`glass-opacity-${val}`);
    }
  };

  const applyStyle = (val: string) => {
    const s = { ...settings, backgroundStyle: val };
    applyAllStyles(s);
  };

  /**
   * Push a Dynamic Island style change everywhere at once:
   *  1. the embedded island in this window (CSS vars are already set by the
   *     control's onChange, this just refreshes its enabled state),
   *  2. the separate Dynamic Island window (via a Tauri event → applies
   *     instantly instead of waiting for its old polling loop),
   *  3. the native window size when the width slider moves.
   * This removes the "must restart the app to see the new style" behaviour.
   */
  const notifyIslandStyle = useCallback(async (patch?: Partial<Settings>) => {
    const s = { ...settings, ...(patch || {}) };
    window.dispatchEvent(new CustomEvent("dynIslandRefresh"));
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("island-style", {
        color: s.dynIslandColor,
        blur: Number(s.dynIslandBlur || 0),
        opacity: Number(s.dynIslandOpacity || 100),
        size: Number(s.dynIslandSize || 300),
        accent: s.themeAccent,
      });
    } catch { /* island window may be closed — style lands on next open */ }
    if (patch?.dynIslandSize) {
      try { await invoke("set_island_size", { width: Number(s.dynIslandSize) }); } catch { /* no window */ }
    }
  }, [settings]);

  const handleBgImagePick = () => {
    bgImageInputRef.current?.click();
  };

  const handleScan = useCallback(async () => {
    if (!scanPath.trim()) return; setScanning(true); setScanResult(null);
    try {
      const count = await LibraryManager.getInstance().scanDirectory(scanPath.trim());
      const all = LibraryManager.getInstance().getAllTracks();
      setScanResult({ type: "success", text: count > 0 ? `Found ${count} new tracks (${all.length} total)` : "No new tracks found — check the folder contains supported audio files (.mp3, .flac, .m4a, .ogg, .wav, etc.)" });
      onTracksLoaded(all);
      await save("scanFolderPath", scanPath.trim());
    } catch (e) { setScanResult({ type: "error", text: String(e) }); }
    setScanning(false);
  }, [scanPath, onTracksLoaded, save]);

  const handleDebugScan = useCallback(async () => {
    if (!scanPath.trim()) return; setDebugScanning(true); setScanResult(null);
    try {
      const result = await invoke<{ path: string; exists: boolean; is_dir: boolean; files_found: number; tracks_parsed: number; errors: string[] }>("debug_scan", { path: scanPath.trim() });
      const lines = [
        `Path: ${result.path}`,
        `Exists: ${result.exists}, IsDir: ${result.is_dir}`,
        `Files found: ${result.files_found}`,
        `Tracks parsed: ${result.tracks_parsed}`,
      ];
      if (result.errors.length > 0) {
        lines.push(`Errors (${result.errors.length}):`);
        for (const e of result.errors.slice(0, 10)) lines.push(`  - ${e}`);
      }
      setScanResult({ type: "debug", text: lines.join("\n") });
    } catch (e) { setScanResult({ type: "error", text: String(e) }); }
    setDebugScanning(false);
  }, [scanPath]);

  const handleScanDownloads = useCallback(async () => {
    setScanning(true); setScanResult(null);
    try {
      // Always use the actual default download dir, not the stored setting
      const dir = await invoke<string>("get_default_download_dir");
      const totalNew = await LibraryManager.getInstance().scanDirectory(dir);
      const all = LibraryManager.getInstance().getAllTracks();
      setScanResult({ type: "success", text: totalNew > 0 ? `Found ${totalNew} new tracks (${all.length} total) in ${dir}` : `No new tracks found in ${dir} — all already imported or no supported files.` });
      onTracksLoaded(all);
    } catch (e) { setScanResult({ type: "error", text: String(e) }); }
    setScanning(false);
  }, [onTracksLoaded]);

  const handleConvertToMp3 = useCallback(async () => {
    setConvertBusy(true);
    setConvertResult(null);
    try {
      const dir = (downloadPath || await invoke<string>("get_default_download_dir")).trim();
      if (!dir) throw new Error("No download folder configured.");
      const res = await invoke<{ converted: { old_path: string; new_path: string }[]; errors: string[] }>("convert_saved_audio_to_mp3", { dir });

      // 1. Remap each converted file in the DB (FK-safe; survive per-file errors).
      const db = DatabaseManager.getInstance();
      const remapErrors: string[] = [];
      for (const c of res.converted) {
        try {
          await db.remapTrackFile(c.old_path, c.new_path);
        } catch (e) {
          remapErrors.push(`${c.old_path}: ${e}`);
        }
      }

      // 2. Reconcile the library with the filesystem: remove ANY track whose
      //    file no longer exists (the .m4a originals are gone after
      //    conversion), then scan the folder so every new .mp3 is added.
      //    This also repairs libraries left stale by an earlier failed run.
      const allTracks = LibraryManager.getInstance().getAllTracks();
      let removedMsg = "";
      if (allTracks.length > 0) {
        const exists = await invoke<boolean[]>("files_exist", { paths: allTracks.map((t) => t.filePath) });
        let removed = 0;
        for (let i = 0; i < allTracks.length; i++) {
          if (!exists[i]) {
            await LibraryManager.getInstance().removeTrack(allTracks[i].id);
            removed++;
          }
        }
        if (removed > 0) {
          removedMsg = ` Removed ${removed} broken track(s) whose files were missing.`;
        }
      }
      await LibraryManager.getInstance().scanDirectory(dir);
      await LibraryManager.getInstance().reload();
      onTracksLoaded(LibraryManager.getInstance().getAllTracks());

      const errText = [...res.errors, ...remapErrors];
      const errMsg = errText.length > 0 ? ` — ${errText.length} failed: ${errText.slice(0, 3).join("; ")}` : "";
      setConvertResult({ type: "success", text: `Converted ${res.converted.length} file(s) to MP3 in ${dir}${errMsg}${removedMsg}` });
    } catch (e) {
      setConvertResult({ type: "error", text: String(e) });
    } finally {
      setConvertBusy(false);
    }
  }, [downloadPath, onTracksLoaded]);

  const styleVal = settings.backgroundStyle || "dark";

  return (
    <div className="settings-view"><h2>Settings</h2>

      <section><h3><IconFolder size={16} style={{ marginRight: 6 }} />Import Music</h3>
        <div style={{ display:"flex", gap:8, marginTop:8 }}>
          <input className="settings-input" style={{ flex:1 }} placeholder="Folder path e.g. C:\\Users\\user\\Music" value={scanPath} onChange={e => setScanPath(e.target.value)} onBlur={() => { if (scanPath.trim()) save("scanFolderPath", scanPath.trim()); }} />
          <button className="settings-btn primary" onClick={handleScan} disabled={scanning}>{scanning ? "Scanning..." : "Scan"}</button>
          <button className="settings-btn" style={{ background:"var(--btn-hover-bg)",color:"var(--text-secondary)",border:"1px solid var(--glass-border-strong)",fontSize:"11px",padding:"6px 10px" }} onClick={handleDebugScan} disabled={debugScanning}>{debugScanning ? "..." : "Debug"}</button>
        </div>
        {scanResult && <div style={{ marginTop:6, fontSize:13, display: "flex", alignItems: "flex-start", gap: 4, color: scanResult.type === "success" ? "var(--color-success)" : scanResult.type === "debug" ? "var(--text-secondary)" : "var(--color-error)", whiteSpace: "pre-wrap" }}>{scanResult.type === "success" ? <IconCheck size={14} /> : scanResult.type === "debug" ? <span style={{fontSize:14}}>🔍</span> : <IconAlert size={14} />}{scanResult.text}</div>}
        <p style={{ marginTop: 6, fontSize: 11, color: "var(--text-tertiary)" }}>Supported: .mp3, .flac, .m4a, .aac, .ogg, .opus, .wav, .wma, .aiff</p>
        {downloadPath ? (
          <div style={{ marginTop: 6 }}>
            <button className="settings-btn" style={{ background:"var(--accent-primary)",color:"#fff",fontSize:"12px" }} onClick={handleScanDownloads} disabled={scanning}>
              {scanning ? "Scanning..." : "📥 Scan Downloads (Desktop\\Music)"}
            </button>
          </div>
        ) : null}
        <label className="settings-check"><input type="checkbox" checked={settings.autoScan==="true"} onChange={e => save("autoScan", e.target.checked?"true":"false")} /> Auto-scan on startup</label>
      </section>

      <section><h3><IconVolume size={16} style={{ marginRight: 6 }} />Audio</h3>
        <label className="settings-row"><span>Crossfade (s)</span><input className="settings-input short" type="number" min="0" max="10" step="0.5" value={settings.crossfade} onChange={e => save("crossfade", e.target.value)} /></label>
        <label className="settings-check"><input type="checkbox" checked={settings.gapless==="true"} onChange={e => save("gapless", e.target.checked?"true":"false")} /> Gapless Playback</label>
      </section>

      {/* ── Equalizer ── */}
      <section><h3><IconVolume size={16} style={{ marginRight: 6 }} />Equalizer</h3>
        <EqSettings />
      </section>

      <section><h3><IconPalette size={16} style={{ marginRight: 6 }} />Appearance</h3>
        <label className="settings-row"><span>Theme</span>
          <select className="settings-input" style={{ width:140 }} value={styleVal} onChange={async e => { await save("backgroundStyle", e.target.value); applyStyle(e.target.value); }}>
            {BACKGROUND_STYLES.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>

        {/* ── Glass mode opacity ── */}
        {styleVal === "glass" && (
          <label className="settings-row"><span>Opacity</span>
            <input className="settings-input range" type="range" min="0" max="100" step="1" value={settings.panelOpacity} onChange={e => {
              save("panelOpacity", e.target.value);
              const val = Math.round(Number(e.target.value) / 10) * 10;
              const h = document.documentElement;
              for (let i = 0; i <= 100; i += 10) h.classList.remove(`glass-opacity-${i}`);
              h.classList.add(`glass-opacity-${val}`);
            }} />
            <span style={{ fontSize:11, color:"var(--text-tertiary)", width:36 }}>{settings.panelOpacity}%</span>
          </label>
        )}

        {/* ── Custom style controls ── */}
        {styleVal === "custom" && (
          <div className="custom-style-controls">
            <label className="settings-row"><span>Background Image</span>
              <button className="settings-btn" style={{ fontSize:12 }} onClick={handleBgImagePick}>Choose Image...</button>
              <input ref={bgImageInputRef} type="file" accept="image/*" style={{ display:"none" }} onChange={e => {
                const file = e.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    save("customBgImage", dataUrl);
                    document.documentElement.style.setProperty("--custom-bg-image", `url(${dataUrl})`);
                  };
                  reader.readAsDataURL(file);
                }
              }} />
              {settings.customBgImage && (
                <button className="settings-btn" style={{ fontSize:11, color:"var(--color-error)" }} onClick={() => {
                  save("customBgImage", "");
                  document.documentElement.style.setProperty("--custom-bg-image", "none");
                }}>Clear</button>
              )}
            </label>
            <label className="settings-row"><span>Background Color</span>
              <input type="color" value={settings.customBgColor} onChange={e => {
                save("customBgColor", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-color", e.target.value);
              }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
            </label>
            <label className="settings-row"><span>Blur</span>
              <input className="settings-input range" type="range" min="0" max="40" step="1" value={settings.customBgBlur} onChange={e => {
                save("customBgBlur", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-blur", `${e.target.value}px`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:28 }}>{settings.customBgBlur}px</span>
            </label>
            <label className="settings-row"><span>Intensity</span>
              <input className="settings-input range" type="range" min="10" max="100" step="1" value={settings.customBgIntensity} onChange={e => {
                save("customBgIntensity", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-intensity", `${Number(e.target.value) / 100}`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:28 }}>{settings.customBgIntensity}%</span>
            </label>
            <label className="settings-row"><span>Gradient Start</span>
              <input type="color" value={settings.customBgGradientStart} onChange={e => {
                save("customBgGradientStart", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-grad-start", e.target.value);
              }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
            </label>
            <label className="settings-row"><span>Gradient End</span>
              <input type="color" value={settings.customBgGradientEnd} onChange={e => {
                save("customBgGradientEnd", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-grad-end", e.target.value);
              }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
            </label>
            <label className="settings-row"><span>Gradient Angle</span>
              <input className="settings-input short" type="number" min="0" max="360" step="1" value={settings.customBgGradientAngle} onChange={e => {
                save("customBgGradientAngle", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-grad-angle", `${e.target.value}deg`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)" }}>deg</span>
            </label>
          </div>
        )}

        <label className="settings-row"><span>Accent</span>
          <input type="color" value={settings.themeAccent} onChange={e => { save("themeAccent", e.target.value); document.documentElement.style.setProperty("--accent-primary", e.target.value); notifyIslandStyle({ themeAccent: e.target.value }); }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
        </label>
      </section>

      {/* ── Dynamic Island ── */}
      <section><h3><IconSettings size={16} style={{ marginRight: 6 }} />Dynamic Island</h3>
        <label className="settings-check">
          <input type="checkbox" checked={settings.dynIslandEnabled === "true"} onChange={async e => {
            const val = e.target.checked ? "true" : "false";
            await save("dynIslandEnabled", val);
            const alwaysOnTop = settings.dynIslandAlwaysOnTop === "true";
            await invoke("toggle_dynamic_island", { enable: e.target.checked, alwaysOnTop });
            notifyIslandStyle();
          }} />
          Enable Dynamic Island <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(separate floating window)</span>
        </label>
        {settings.dynIslandEnabled === "true" && (
          <div className="custom-style-controls">
            <label className="settings-check">
              <input type="checkbox" checked={settings.dynIslandAlwaysOnTop === "true"} onChange={async e => {
                const val = e.target.checked ? "true" : "false";
                await save("dynIslandAlwaysOnTop", val);
                await invoke("set_island_always_on_top", { alwaysOnTop: e.target.checked });
              }} />
              Always on Top <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(stays above other apps)</span>
            </label>
            <label className="settings-row"><span>Color</span>
              <input type="color" value={settings.dynIslandColor} onChange={e => {
                save("dynIslandColor", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-bg", e.target.value);
                notifyIslandStyle({ dynIslandColor: e.target.value });
              }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
            </label>
            <label className="settings-row"><span>Blur</span>
              <input className="settings-input range" type="range" min="0" max="60" step="1" value={settings.dynIslandBlur} onChange={e => {
                save("dynIslandBlur", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-blur", `${e.target.value}px`);
                notifyIslandStyle({ dynIslandBlur: e.target.value });
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:32, flexShrink:0 }}>{settings.dynIslandBlur}px</span>
            </label>
            <label className="settings-row"><span>Opacity</span>
              <input className="settings-input range" type="range" min="20" max="100" step="1" value={settings.dynIslandOpacity} onChange={e => {
                save("dynIslandOpacity", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-opacity", `${Number(e.target.value) / 100}`);
                notifyIslandStyle({ dynIslandOpacity: e.target.value });
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:32, flexShrink:0 }}>{settings.dynIslandOpacity}%</span>
            </label>
            <label className="settings-row"><span>Size (width)</span>
              <input className="settings-input range" type="range" min="160" max="640" step="10" value={settings.dynIslandSize} onChange={e => {
                save("dynIslandSize", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-width", `${e.target.value}px`);
                notifyIslandStyle({ dynIslandSize: e.target.value });
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:32, flexShrink:0 }}>{settings.dynIslandSize}px</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={settings.dynIslandLyrics === "true"} onChange={async e => {
                const val = e.target.checked ? "true" : "false";
                await save("dynIslandLyrics", val);
                notifyIslandStyle();
              }} />
              Show lyrics <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(when the track has lyrics)</span>
            </label>
          </div>
        )}
      </section>

      {/* ── LAN Sync (experimental) ── */}
      <section><h3><IconSettings size={16} style={{ marginRight: 6 }} />LAN Sync <span style={{ fontSize:10, color:"var(--text-tertiary)", fontWeight:400 }}>(experimental)</span></h3>
        <p style={{ fontSize:12, color:"var(--text-tertiary)", marginBottom:10, lineHeight:1.5 }}>
          Share your library with the web player on your phone (same Wi-Fi, e.g. Safari on iPhone).
          Start the server, then open the shown address on the phone — it loads the web player
          from this computer and streams tracks straight from your library. The address contains a
          security token; only use on trusted networks.
        </p>
        {lanUrl && (
          <div style={{ marginBottom:10 }}>
            <code style={{ fontSize:12, background:"rgba(255,255,255,.06)", padding:"6px 10px", borderRadius:6, color:"var(--text-body)", wordBreak:"break-all", display:"inline-block" }}>{lanUrl}</code>
            <button
              className="settings-btn"
              style={{ marginLeft:8, padding:"4px 10px", fontSize:12 }}
              onClick={async () => { try { await navigator.clipboard.writeText(lanUrl); } catch { /* ignore */ } }}
            >Copy</button>
          </div>
        )}
        {lanError && <p style={{ fontSize:12, color:"var(--color-error)", marginBottom:8 }}>{lanError}</p>}
        <button
          className={`settings-btn ${lanUrl ? "" : "primary"}`}
          disabled={lanBusy}
          onClick={async () => {
            setLanBusy(true); setLanError(null);
            try {
              if (lanUrl) {
                await invoke("lan_server_stop");
                setLanUrl("");
              } else {
                const url = await invoke<string>("lan_server_start");
                setLanUrl(url);
              }
            } catch (e) {
              setLanError(String(e));
            } finally {
              setLanBusy(false);
            }
          }}
        >
          {lanBusy ? "…" : lanUrl ? "Stop Server" : "Start Server"}
        </button>
      </section>

      <section><h3><IconSettings size={16} style={{ marginRight: 6 }} />Behavior</h3>
        <label className="settings-check"><input type="checkbox" checked={settings.minimizeToTray==="true"} onChange={e => save("minimizeToTray", e.target.checked?"true":"false")} /> Minimize to tray <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(hides to system tray on minimize)</span></label>
        <label className="settings-check"><input type="checkbox" checked={settings.closeToTray==="true"} onChange={async e => {
          const val = e.target.checked ? "true" : "false";
          await save("closeToTray", val);
          await invoke("set_close_to_tray", { enable: e.target.checked });
        }} /> Close to tray <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(hides instead of quitting)</span></label>
        <label className="settings-check"><input type="checkbox" checked={settings.gamingDetect==="true"} onChange={e => save("gamingDetect", e.target.checked?"true":"false")} /> Gaming Mode <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(lowers volume when window loses focus)</span></label>
        <label className="settings-check"><input type="checkbox" checked={settings.discordRpc==="true"} onChange={async e => {
          const rpc = DiscordRpcService.getInstance();
          if (e.target.checked) {
            try {
              await rpc.enable();
              await save("discordRpc", "true");
            } catch (err) {
              // Failed to connect — revert checkbox and show error.
              await save("discordRpc", "false");
              setSettings(p => ({ ...p, discordRpc: "false" }));
              setScanResult({ type: "error", text: String(err) });
            }
          } else {
            await rpc.disable();
            await save("discordRpc", "false");
          }
        }} /> Discord Rich Presence <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(shows what you're listening to on your profile)</span></label>
      </section>

      {/* ── Hotkeys ── */}
      <section><h3><IconSettings size={16} style={{ marginRight: 6 }} />Keyboard Shortcuts</h3>
        <HotkeySettings />
      </section>

      <section><h3><IconRocket size={16} style={{ marginRight: 6 }} />Startup</h3>
        <label className="settings-check"><input type="checkbox" checked={settings.autoStart==="true"} onChange={async e => {
          const enable = e.target.checked;
          await save("autoStart", enable ? "true" : "false");
          await invoke("set_autostart", { enable });
        }} /> Start on login <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:4 }}>(launches when you sign in)</span></label>
      </section>

      <section><h3><IconFolder size={16} style={{ marginRight: 6 }} />Cache</h3>
        <div style={{ marginTop: 8 }}>
          {cacheInfo ? (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
              <div>Downloaded audio cache: <strong>{cacheInfo.size_mb.toFixed(1)} MB</strong> ({cacheInfo.file_count} files)</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{cacheInfo.cache_dir}</div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 8 }}>Loading cache info...</div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="settings-btn" style={{ fontSize: 12 }} onClick={handleClearCache} disabled={clearingCache || !cacheInfo || cacheInfo.file_count === 0}>
              {clearingCache ? "Clearing..." : "Clear Cache"}
            </button>
            <button className="settings-btn" style={{ fontSize: 12 }} onClick={loadCacheInfo}>Refresh</button>
          </div>
          <label className="settings-row" style={{ marginTop: 12 }}><span>Max Cache (MB)</span>
            <input className="settings-input short" type="number" min="50" max="10000" step="50" value={settings.maxCacheMb} onChange={e => save("maxCacheMb", e.target.value)} />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Auto-clear when exceeded</span>
          </label>
        </div>
      </section>

      {/* ── Online Search ── */}
      <section><h3><IconRocket size={16} style={{ marginRight: 6 }} />Online Search</h3>
        {/* Download Path */}
        <label className="settings-row"><span>Download to</span></label>
        <div style={{ display: "flex", gap: 8, marginTop: 4, marginBottom: 8 }}>
          <input
            className="settings-input"
            style={{ flex: 1, fontSize: 12 }}
            placeholder="e.g. C:\Users\user\Music\NeedMusic"
            value={downloadPath}
            onChange={e => setDownloadPath(e.target.value)}
            onBlur={() => { if (downloadPath.trim()) save("onlineDownloadPath", downloadPath.trim()); }}
          />
          <button
            className="settings-btn"
            style={{ fontSize: 11, whiteSpace: "nowrap" }}
            onClick={async () => {
              try {
                const def = await invoke<string>("get_default_download_dir");
                setDownloadPath(def);
                await save("onlineDownloadPath", def);
              } catch { /* ignore */ }
            }}
          >
            Reset Default
          </button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Downloaded music from Bilibili & YouTube is saved here. Separate from your import folder.
          MP3 conversion needs ffmpeg — it is downloaded automatically on first use (~80 MB, may take a minute).
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <button
            className="settings-btn"
            style={{ fontSize: 11 }}
            onClick={handleConvertToMp3}
            disabled={convertBusy}
          >
            {convertBusy ? "Converting…" : "Convert saved music to MP3"}
          </button>
          {convertResult && (
            <span style={{ fontSize: 12, color: convertResult.type === "success" ? "var(--color-success)" : "var(--color-error)" }}>
              {convertResult.text}
            </span>
          )}
        </div>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.youtubeSearch === "true"}
            onChange={async e => {
              const val = e.target.checked ? "true" : "false";
              await save("youtubeSearch", val);
            }}
            disabled={!ytDlpAvailable}
          />
          Enable YouTube search
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 4 }}>
            (audio only — requires yt-dlp)
          </span>
        </label>
        {!ytDlpAvailable && (
          <div style={{ fontSize: 12, color: "var(--text-warning)", marginTop: 6 }}>
            yt-dlp is not installed.{" "}
            <a
              href="https://github.com/yt-dlp/yt-dlp"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent-primary)" }}
            >
              Install yt-dlp
            </a>
            {" "}or run: <code>pip install yt-dlp</code>
          </div>
        )}
        {settings.youtubeSearch === "true" && ytDlpAvailable && (
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 }}>
            YouTube search is enabled. Results will appear alongside Bilibili when you search.
            Downloads are audio-only (no video).
          </div>
        )}
        {settings.youtubeSearch === "true" && (
          <div style={{
            fontSize: 11,
            color: "var(--color-error)",
            marginTop: 8,
            padding: "8px 10px",
            background: "rgba(233, 69, 96, 0.08)",
            border: "1px solid rgba(233, 69, 96, 0.2)",
            borderRadius: "var(--radius-sm)",
            lineHeight: 1.5,
          }}>
            <strong>⚠ Use at your own risk.</strong> Downloading audio from YouTube may violate
            YouTube's Terms of Service. This feature is provided for personal, educational use only.
            The developers are not responsible for how you use it. Proceed at your own discretion.
          </div>
        )}
      </section>
    </div>
  );
};

export default SettingsView;
