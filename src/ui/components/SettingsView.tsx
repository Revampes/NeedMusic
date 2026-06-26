import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { LibraryManager } from "@core/services/LibraryManager";
import { DiscordRpcService } from "@core/services/DiscordRpcService";
import { Track } from "@core/models/Track";
import { IconFolder, IconVolume, IconPalette, IconSettings, IconRocket, IconCheck, IconAlert } from "@ui/components/Icons";

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
  dynIslandOpacity: "85",
  // Cache
  maxCacheMb: "500",
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
  const [scanResult, setScanResult] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const bgImageInputRef = useRef<HTMLInputElement>(null);
  const db = DatabaseManager.getInstance();

  useEffect(() => { (async () => {
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) { const v = await db.getSetting(k); if (v !== null) s[k] = v; }
    setSettings(s);
    const sp = await db.getSetting("scanFolderPath"); if (sp) setScanPath(sp);
    // Restore appearance
    applyAllStyles(s);
  })(); }, [db]);

  // Load cache info
  const loadCacheInfo = useCallback(async () => {
    try {
      const info = await invoke<CacheInfo>("get_online_cache_info");
      setCacheInfo(info);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadCacheInfo(); }, [loadCacheInfo]);

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

  const handleBgImagePick = () => {
    bgImageInputRef.current?.click();
  };

  const handleScan = useCallback(async () => {
    if (!scanPath.trim()) return; setScanning(true); setScanResult(null);
    try {
      await LibraryManager.getInstance().scanDirectory(scanPath.trim());
      setScanResult({ type: "success", text: "Done" }); onTracksLoaded(LibraryManager.getInstance().getAllTracks());
      await save("scanFolderPath", scanPath.trim());
    } catch (e) { setScanResult({ type: "error", text: String(e) }); }
    setScanning(false);
  }, [scanPath, onTracksLoaded, save]);

  const styleVal = settings.backgroundStyle || "dark";

  return (
    <div className="settings-view"><h2>Settings</h2>

      <section><h3><IconFolder size={16} style={{ marginRight: 6 }} />Import Music</h3>
        <div style={{ display:"flex", gap:8, marginTop:8 }}>
          <input className="settings-input" style={{ flex:1 }} placeholder="Folder path e.g. C:\\Users\\user\\Music" value={scanPath} onChange={e => setScanPath(e.target.value)} onBlur={() => { if (scanPath.trim()) save("scanFolderPath", scanPath.trim()); }} />
          <button className="settings-btn primary" onClick={handleScan} disabled={scanning}>{scanning ? "Scanning..." : "Scan"}</button>
        </div>
        {scanResult && <div style={{ marginTop:6, fontSize:13, display: "flex", alignItems: "center", gap: 4, color: scanResult.type === "success" ? "var(--color-success)" : "var(--color-error)" }}>{scanResult.type === "success" ? <IconCheck size={14} /> : <IconAlert size={14} />}{scanResult.text}</div>}
        <label className="settings-check"><input type="checkbox" checked={settings.autoScan==="true"} onChange={e => save("autoScan", e.target.checked?"true":"false")} /> Auto-scan on startup</label>
      </section>

      <section><h3><IconVolume size={16} style={{ marginRight: 6 }} />Audio</h3>
        <label className="settings-row"><span>Crossfade (s)</span><input className="settings-input short" type="number" min="0" max="10" step="0.5" value={settings.crossfade} onChange={e => save("crossfade", e.target.value)} /></label>
        <label className="settings-check"><input type="checkbox" checked={settings.gapless==="true"} onChange={e => save("gapless", e.target.checked?"true":"false")} /> Gapless Playback</label>
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
            <input className="settings-input short" type="range" min="0" max="100" step="1" value={settings.panelOpacity} onChange={e => {
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
              <input className="settings-input short" type="range" min="0" max="40" step="1" value={settings.customBgBlur} onChange={e => {
                save("customBgBlur", e.target.value);
                document.documentElement.style.setProperty("--custom-bg-blur", `${e.target.value}px`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:28 }}>{settings.customBgBlur}px</span>
            </label>
            <label className="settings-row"><span>Intensity</span>
              <input className="settings-input short" type="range" min="10" max="100" step="1" value={settings.customBgIntensity} onChange={e => {
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
          <input type="color" value={settings.themeAccent} onChange={e => { save("themeAccent", e.target.value); document.documentElement.style.setProperty("--accent-primary", e.target.value); }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
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
              }} style={{ width:32, height:28, border:"none", borderRadius:4, cursor:"pointer" }} />
            </label>
            <label className="settings-row"><span>Blur</span>
              <input className="settings-input short" type="range" min="0" max="60" step="1" value={settings.dynIslandBlur} onChange={e => {
                save("dynIslandBlur", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-blur", `${e.target.value}px`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:28 }}>{settings.dynIslandBlur}px</span>
            </label>
            <label className="settings-row"><span>Opacity</span>
              <input className="settings-input short" type="range" min="20" max="100" step="1" value={settings.dynIslandOpacity} onChange={e => {
                save("dynIslandOpacity", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-opacity", `${Number(e.target.value) / 100}`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:28 }}>{settings.dynIslandOpacity}%</span>
            </label>
            <label className="settings-row"><span>Size (width)</span>
              <input className="settings-input short" type="range" min="240" max="480" step="10" value={settings.dynIslandSize} onChange={e => {
                save("dynIslandSize", e.target.value);
                document.documentElement.style.setProperty("--dyn-island-width", `${e.target.value}px`);
              }} />
              <span style={{ fontSize:11, color:"var(--text-tertiary)", width:32 }}>{settings.dynIslandSize}px</span>
            </label>
          </div>
        )}
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
    </div>
  );
};

export default SettingsView;
