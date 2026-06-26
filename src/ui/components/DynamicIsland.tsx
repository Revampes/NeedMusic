import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ITrack, PlayerState, PlaybackState } from "@core/interfaces";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { IconPlay, IconPause, IconPrevious, IconNext, IconClose } from "@ui/components/Icons";

interface DynamicIslandProps {
  player: PlayerState;
  nextTrack: ITrack | null;
}

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const DynamicIsland: React.FC<DynamicIslandProps> = ({ player, nextTrack }) => {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 20, y: 20 });
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const islandRef = useRef<HTMLDivElement>(null);
  const db = DatabaseManager.getInstance();

  // Load saved position and visibility
  useEffect(() => {
    (async () => {
      const enabled = await db.getSetting("dynIslandEnabled");
      if (enabled === "true") setVisible(true);
      const sx = await db.getSetting("dynIslandX");
      const sy = await db.getSetting("dynIslandY");
      if (sx && sy) setPos({ x: Number(sx), y: Number(sy) });
    })();
  }, [db]);

  // Listen for settings changes (polling via window event)
  useEffect(() => {
    const checkEnabled = async () => {
      const enabled = await db.getSetting("dynIslandEnabled");
      setVisible(enabled === "true");
    };
    const interval = setInterval(checkEnabled, 2000);
    // Also check on storage events
    const onStorage = () => checkEnabled();
    window.addEventListener("storage", onStorage);
    return () => { clearInterval(interval); window.removeEventListener("storage", onStorage); };
  }, [db]);

  // Also listen for a custom event from SettingsView
  useEffect(() => {
    const handler = async () => {
      const enabled = await db.getSetting("dynIslandEnabled");
      setVisible(enabled === "true");
    };
    window.addEventListener("dynIslandRefresh", handler);
    return () => window.removeEventListener("dynIslandRefresh", handler);
  }, [db]);

  const savePosition = useCallback(async (x: number, y: number) => {
    await db.setSetting("dynIslandX", String(Math.round(x)));
    await db.setSetting("dynIslandY", String(Math.round(y)));
  }, [db]);

  // ── Dragging ──
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".di-btn, .di-progress")) return;
    setDragging(true);
    setDragOffset({ x: e.clientX - pos.x, y: e.clientY - pos.y });
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const nx = Math.max(0, Math.min(window.innerWidth - 320, e.clientX - dragOffset.x));
      const ny = Math.max(0, Math.min(window.innerHeight - 160, e.clientY - dragOffset.y));
      setPos({ x: nx, y: ny });
    };
    const up = () => {
      setDragging(false);
      savePosition(pos.x, pos.y);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [dragging, dragOffset, pos, savePosition]);

  if (!visible) return null;

  const ct = player.currentTrack;
  const isPlaying = player.playbackState === "playing" as PlaybackState;
  const progressPct = player.durationSecs > 0 ? (player.currentTimeSecs / player.durationSecs) * 100 : 0;
  const engine = PlaybackEngine.getInstance();

  return (
    <div
      ref={islandRef}
      className={`dynamic-island ${dragging ? "di-dragging" : ""}`}
      style={{
        left: pos.x,
        top: pos.y,
        width: "var(--dyn-island-width, 300px)",
      }}
      onMouseDown={handleMouseDown}
    >
      {/* ── Glow orb ── */}
      <div className="di-glow" />

      {/* ── Header: drag handle + close ── */}
      <div className="di-header">
        <div className="di-drag-handle">
          <span className="di-pill" />
        </div>
        <button
          className="di-close-btn"
          onClick={async () => {
            setVisible(false);
            await db.setSetting("dynIslandEnabled", "false");
            window.dispatchEvent(new CustomEvent("dynIslandRefresh"));
          }}
          title="Hide Dynamic Island"
        >
          <IconClose size={12} />
        </button>
      </div>

      {/* ── Now Playing ── */}
      <div className="di-now-playing">
        <div className="di-artwork">
          {ct?.hasArtwork ? (
            <div className="di-artwork-img">🎵</div>
          ) : (
            <div className="di-artwork-placeholder">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
              </svg>
            </div>
          )}
        </div>
        <div className="di-track-info">
          <div className="di-title">{ct?.title || "No track playing"}</div>
          <div className="di-artist">{ct?.displayArtist() || "—"}</div>
        </div>
        {/* Mini visualizer bars */}
        {isPlaying && (
          <div className="di-visualizer">
            <span className="di-bar" /><span className="di-bar" /><span className="di-bar" /><span className="di-bar" />
          </div>
        )}
      </div>

      {/* ── Progress ── */}
      <div className="di-progress-section">
        <div className="di-progress-track">
          <div className="di-progress-fill" style={{ width: `${progressPct}%` }} />
          <div className="di-progress-thumb" style={{ left: `${progressPct}%` }} />
        </div>
        <div className="di-time-row">
          <span className="di-time">{fmtTime(player.currentTimeSecs)}</span>
          <span className="di-time">{fmtTime(player.durationSecs)}</span>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="di-controls">
        <button className="di-btn" onClick={() => engine.previous()} title="Previous">
          <IconPrevious size={15} />
        </button>
        <button className="di-btn di-btn-play" onClick={() => isPlaying ? engine.pause() : engine.resume()} title={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
        </button>
        <button className="di-btn" onClick={() => engine.next()} title="Next">
          <IconNext size={15} />
        </button>
      </div>

      {/* ── Up Next ── */}
      {nextTrack && (
        <div className="di-up-next">
          <div className="di-up-next-label">Up Next</div>
          <div className="di-up-next-track">
            <span className="di-up-next-icon">♪</span>
            <div className="di-up-next-info">
              <span className="di-up-next-title">{nextTrack.title}</span>
              <span className="di-up-next-artist">{nextTrack.displayArtist()}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DynamicIsland;
