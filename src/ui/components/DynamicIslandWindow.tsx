import React, { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { IconPlay, IconPause, IconPrevious, IconNext, IconClose } from "@ui/components/Icons";
import MarqueeText from "@ui/components/MarqueeText";

// Minimal inline styles since this is a separate window with no global.css
const STYLES = `
:root {
  --accent-primary: #e94560;
  --accent-hover: #ff6b81;
  --accent-glow: rgba(233, 69, 96, 0.3);
  --dyn-island-bg: #1a1a2e;
  --dyn-island-blur: 20px;
  --dyn-island-opacity: 0.85;
  --dyn-island-width: 300px;
  --font-mono: "JetBrains Mono", "Cascadia Code", "Consolas", monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:transparent!important;font-family:"Inter","Segoe UI",-apple-system,sans-serif;color:#fff}

.dynamic-island-window {
  width: 100vw; height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 4px; background: transparent;
}
.dynamic-island {
  width: min(var(--dyn-island-width, 300px), calc(100vw - 8px));
  background: color-mix(in srgb, var(--dyn-island-bg, #1a1a2e) var(--dyn-island-opacity, 85%), transparent);
  backdrop-filter: blur(var(--dyn-island-blur, 20px)) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--dyn-island-blur, 20px)) saturate(1.4);
  border: none;
  border-radius: 20px;
  padding: 14px 16px 12px;
  cursor: default;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  overflow: hidden; position: relative;
}
.di-glow {
  position: absolute; top:-30px; right:-20px; width:80px; height:80px;
  background: radial-gradient(circle, rgba(233,69,96,0.25) 0%, transparent 70%);
  border-radius: 50%; pointer-events: none;
  animation: diGlowPulse 3s ease-in-out infinite;
}
@keyframes diGlowPulse { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:.9;transform:scale(1.1)} }
.di-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.di-drag-handle { display:flex; justify-content:center; flex:1; margin-left:20px; cursor:grab; }
.di-pill { display:block; width:32px; height:3px; background:rgba(255,255,255,.25); border-radius:2px; }
.di-close-btn { background:none; border:none; color:rgba(255,255,255,.35); cursor:pointer; padding:4px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
.di-close-btn:hover { color:#fff; background:rgba(255,255,255,.1); }
.di-now-playing { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.di-artwork { width:40px; height:40px; border-radius:10px; background:rgba(255,255,255,.08); display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,.3); }
.di-artwork-placeholder { color:rgba(255,255,255,.4); display:flex; }
.di-track-info { flex:1; min-width:0; overflow:hidden; }
.di-title { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.3; text-shadow:0 1px 4px rgba(0,0,0,.4); }
.di-artist { font-size:11px; color:rgba(255,255,255,.6); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:1px; }
.di-visualizer { display:flex; align-items:flex-end; gap:2px; height:20px; flex-shrink:0; margin-left:auto; }
.di-bar { width:3px; background:var(--accent-primary); border-radius:2px; animation:diBarAnim 1.2s ease-in-out infinite; }
.di-bar:nth-child(1){height:8px;animation-delay:0s} .di-bar:nth-child(2){height:14px;animation-delay:.2s}
.di-bar:nth-child(3){height:10px;animation-delay:.4s} .di-bar:nth-child(4){height:16px;animation-delay:.6s}
@keyframes diBarAnim { 0%,100%{transform:scaleY(.4);opacity:.5} 50%{transform:scaleY(1);opacity:1} }
.di-progress-section { margin-bottom:8px; }
.di-progress-track { height:3px; background:rgba(255,255,255,.1); border-radius:2px; position:relative; margin-bottom:3px; }
.di-progress-fill { height:100%; background:linear-gradient(90deg,var(--accent-primary),var(--accent-hover)); border-radius:2px; position:relative; }
.di-progress-fill::after { content:''; position:absolute; right:-3px; top:-2px; width:7px; height:7px; background:#fff; border-radius:50%; box-shadow:0 0 6px var(--accent-glow); }
.di-time-row { display:flex; justify-content:space-between; }
.di-time { font-family:var(--font-mono); font-size:10px; color:rgba(255,255,255,.4); }
.di-controls { display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:8px; }
.di-btn { background:none; border:none; color:rgba(255,255,255,.6); cursor:pointer; padding:6px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
.di-btn:hover { color:#fff; background:rgba(255,255,255,.1); }
.di-btn-play { width:34px; height:34px; background:var(--accent-primary); color:#fff; border-radius:50%; box-shadow:0 2px 12px rgba(233,69,96,.4); }
.di-btn-play:hover { background:var(--accent-hover); }
.di-up-next { border-top:1px solid rgba(255,255,255,.06); padding-top:8px; }
.di-up-next-label { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:rgba(255,255,255,.3); margin-bottom:4px; }
.di-up-next-track { display:flex; align-items:center; gap:6px; }
.di-up-next-icon { font-size:11px; color:rgba(255,255,255,.3); flex-shrink:0; }
.di-up-next-info { flex:1; min-width:0; overflow:hidden; }
.di-up-next-title { font-size:11px; color:rgba(255,255,255,.55); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
.di-up-next-artist { font-size:10px; color:rgba(255,255,255,.3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; margin-top:1px; }
.di-empty { text-align:center; padding:30px 16px; color:rgba(255,255,255,.3); font-size:13px; }
.di-empty-icon { font-size:28px; margin-bottom:8px; display:block; }
`;

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface IslandState {
  currentTrack: { title: string; artist: string; hasArtwork: boolean } | null;
  playbackState: string;
  currentTimeSecs: number;
  durationSecs: number;
  nextTrack: { title: string; artist: string } | null;
}

const DynamicIslandWindow: React.FC = () => {
  const [state, setState] = useState<IslandState>({
    currentTrack: null, playbackState: "idle",
    currentTimeSecs: 0, durationSecs: 0, nextTrack: null,
  });
  const islandRef = useRef<HTMLDivElement>(null);

  // ── Load saved style settings ──
  useEffect(() => {
    (async () => {
      const db = DatabaseManager.getInstance();
      const color = await db.getSetting("dynIslandColor");
      if (color) document.documentElement.style.setProperty("--dyn-island-bg", color);
      const blur = await db.getSetting("dynIslandBlur");
      if (blur) document.documentElement.style.setProperty("--dyn-island-blur", `${blur}px`);
      const opacity = await db.getSetting("dynIslandOpacity");
      if (opacity) document.documentElement.style.setProperty("--dyn-island-opacity", `${Number(opacity) / 100}`);
      const size = await db.getSetting("dynIslandSize");
      if (size) document.documentElement.style.setProperty("--dyn-island-width", `${size}px`);
      const acc = await db.getSetting("themeAccent");
      if (acc) { document.documentElement.style.setProperty("--accent-primary", acc); }
    })();
  }, []);

  // ── Listen for state updates from main window ──
  useEffect(() => {
    const unlistenPromises: Promise<() => void>[] = [];
    const setup = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten1 = await listen<IslandState>("island-state", (event) => {
        setState(event.payload);
      });
      unlistenPromises.push(Promise.resolve(unlisten1));
    };
    setup();
    return () => { /* cleanup via window close */ };
  }, []);

  // ── Listen for style updates ──
  useEffect(() => {
    const interval = setInterval(async () => {
      const db = DatabaseManager.getInstance();
      const color = await db.getSetting("dynIslandColor");
      if (color) document.documentElement.style.setProperty("--dyn-island-bg", color);
      const blur = await db.getSetting("dynIslandBlur");
      if (blur) document.documentElement.style.setProperty("--dyn-island-blur", `${blur}px`);
      const opacity = await db.getSetting("dynIslandOpacity");
      if (opacity) document.documentElement.style.setProperty("--dyn-island-opacity", `${Number(opacity) / 100}`);
      const size = await db.getSetting("dynIslandSize");
      if (size) document.documentElement.style.setProperty("--dyn-island-width", `${size}px`);
      const acc = await db.getSetting("themeAccent");
      if (acc) { document.documentElement.style.setProperty("--accent-primary", acc); }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // ── Native window dragging ──
  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".di-btn")) return;
    e.preventDefault();
    try {
      await getCurrentWindow().startDragging();
    } catch { /* fallback: manual drag not needed */ }
  }, []);

  // ── Emit commands to main window ──
  const emitCommand = useCallback(async (cmd: string) => {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("island-command", { command: cmd });
    } catch { /* ignore */ }
  }, []);

  // ── Close → tell main window to close this ──
  const handleClose = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("toggle_dynamic_island", { enable: false, alwaysOnTop: true });
    } catch { /* ignore */ }
    const db = DatabaseManager.getInstance();
    await db.setSetting("dynIslandEnabled", "false");
  }, []);

  const ct = state.currentTrack;
  const isPlaying = state.playbackState === "playing";
  const progressPct = state.durationSecs > 0 ? (state.currentTimeSecs / state.durationSecs) * 100 : 0;

  return (
    <div className="dynamic-island-window">
      <style>{STYLES}</style>
      <div
        ref={islandRef}
        className="dynamic-island"
        onMouseDown={handleDragStart}
      >
        <div className="di-glow" />
        <div className="di-header">
          <div className="di-drag-handle">
            <span className="di-pill" />
          </div>
          <button className="di-close-btn" onClick={handleClose} title="Close Dynamic Island">
            <IconClose size={12} />
          </button>
        </div>

        {ct ? (
          <>
            <div className="di-now-playing">
              <div className="di-artwork">
                <div className="di-artwork-placeholder">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
                  </svg>
                </div>
              </div>
              <div className="di-track-info">
                <MarqueeText className="di-title">{ct.title}</MarqueeText>
                <MarqueeText className="di-artist">{ct.artist}</MarqueeText>
              </div>
              {isPlaying && (
                <div className="di-visualizer">
                  <span className="di-bar" /><span className="di-bar" /><span className="di-bar" /><span className="di-bar" />
                </div>
              )}
            </div>

            <div className="di-progress-section">
              <div className="di-progress-track">
                <div className="di-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="di-time-row">
                <span className="di-time">{fmtTime(state.currentTimeSecs)}</span>
                <span className="di-time">{fmtTime(state.durationSecs)}</span>
              </div>
            </div>

            <div className="di-controls">
              <button className="di-btn" onClick={() => emitCommand("previous")} title="Previous">
                <IconPrevious size={15} />
              </button>
              <button className="di-btn di-btn-play" onClick={() => emitCommand(isPlaying ? "pause" : "play")} title={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
              </button>
              <button className="di-btn" onClick={() => emitCommand("next")} title="Next">
                <IconNext size={15} />
              </button>
            </div>

            {state.nextTrack && (
              <div className="di-up-next">
                <div className="di-up-next-label">Up Next</div>
                <div className="di-up-next-track">
                  <span className="di-up-next-icon">♪</span>
                  <div className="di-up-next-info">
                    <MarqueeText className="di-up-next-title">{state.nextTrack.title}</MarqueeText>
                    <MarqueeText className="di-up-next-artist">{state.nextTrack.artist}</MarqueeText>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="di-empty">
            <span className="di-empty-icon">🎵</span>
            No track playing
          </div>
        )}
      </div>
    </div>
  );
};

export default DynamicIslandWindow;
