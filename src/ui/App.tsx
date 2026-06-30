import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppBootstrapper } from "@core/AppBootstrapper";
import { MediaControlBridge } from "@core/services/MediaControlBridge";
import { PlaybackEngine, PlaybackState, RepeatMode } from "@core/services/PlaybackEngine";
import { LibraryManager } from "@core/services/LibraryManager";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { DiscordRpcService } from "@core/services/DiscordRpcService";
import type { ITrack, PlayerState } from "@core/interfaces";
import { Track } from "@core/models/Track";
import { Album } from "@core/models/Album";
import { Artist } from "@core/models/Artist";
import { BackgroundEngine } from "@core/utils/BackgroundEngine";
import { CustomContextMenu, ContextMenuEntry } from "@ui/components/CustomContextMenu";
import ProgressBar from "@ui/components/ProgressBar";
import PlaylistsView from "@ui/components/PlaylistsView";
import SettingsView from "@ui/components/SettingsView";
import OnlineSearchView from "@ui/components/OnlineSearchView";
import CustomTitleBar from "@ui/components/CustomTitleBar";
import QueuePanel from "@ui/components/QueuePanel";
import MarqueeText from "@ui/components/MarqueeText";
import {
  IconLibrary, IconHeart, IconHeartFill, IconPlaylist, IconSettings,
  IconMusic, IconImage, IconPrevious, IconPlay, IconPause, IconNext, IconStop,
  IconRepeatOff, IconRepeat, IconRepeatOne, IconShuffle, IconVolume,
  IconClock, IconPlus, IconDisc, IconMic, IconGlobe, IconClose,
} from "@ui/components/Icons";
import "./styles/design-tokens.css";
import "./styles/global.css";

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const FILTERS = ["All", "Title", "Artist", "Album", "Genre"];

const App: React.FC = () => {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const [bgClass, setBgClass] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [activeTab, setActiveTab] = useState("Tracks");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterField, setFilterField] = useState("All");
  const [player, setPlayer] = useState<PlayerState>({
    currentTrack: null, playbackState: PlaybackState.Idle,
    currentTimeSecs: 0, durationSecs: 0, volume: 1, playbackRate: 1,
    repeatMode: RepeatMode.Off, isShuffled: false, isFavorite: false, buffering: false,
  });
  const engine = useMemo(() => PlaybackEngine.getInstance(), []);

  useEffect(() => {
    let timedOut = false;
    let islandInterval: ReturnType<typeof setInterval> | null = null;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      console.error("[NeedMusic] Initialization timed out after 15 seconds");
      setError("Initialization timed out. The database or a Tauri plugin may not be responding. Check the terminal for errors.");
    }, 15000);

    AppBootstrapper.getInstance().initialize().then(async () => {
      if (timedOut) return;
      console.log("[NeedMusic] Bootstrap OK, starting MediaControlBridge...");
      await MediaControlBridge.getInstance().start();

      const db = DatabaseManager.getInstance();
      // ── Restore appearance settings ──
      const restoreTheme = async () => {
        const h = document.documentElement;
        h.classList.remove("theme-dark", "theme-light", "theme-glass", "theme-custom");
        for (let i = 0; i <= 100; i += 10) h.classList.remove(`glass-opacity-${i}`);
        const bgStyle = await db.getSetting("backgroundStyle");
        if (bgStyle) {
          h.classList.add(`theme-${bgStyle}`);
          setBgClass(bgStyle === "glass" ? "glass-style" : "");
        }
        const blur = await db.getSetting("blurIntensity");
        if (blur) h.style.setProperty("--glass-blur", `${blur}px`);
        const accent = await db.getSetting("themeAccent");
        if (accent) h.style.setProperty("--accent-primary", accent);
        const opacity = await db.getSetting("panelOpacity");
        if (opacity && bgStyle === "glass") {
          const v = Math.round(Number(opacity) / 10) * 10;
          for (let i = 0; i <= 100; i += 10) h.classList.remove(`glass-opacity-${i}`);
          h.classList.add(`glass-opacity-${v}`);
        }
        // Custom style restore
        const customBgColor = await db.getSetting("customBgColor");
        if (customBgColor) h.style.setProperty("--custom-bg-color", customBgColor);
        const customBgBlur = await db.getSetting("customBgBlur");
        if (customBgBlur) h.style.setProperty("--custom-bg-blur", `${customBgBlur}px`);
        const customBgIntensity = await db.getSetting("customBgIntensity");
        if (customBgIntensity) h.style.setProperty("--custom-bg-intensity", `${Number(customBgIntensity) / 100}`);
        const customBgImg = await db.getSetting("customBgImage");
        if (customBgImg) h.style.setProperty("--custom-bg-image", `url(${customBgImg})`);
        const gradStart = await db.getSetting("customBgGradientStart");
        if (gradStart) h.style.setProperty("--custom-bg-grad-start", gradStart);
        const gradEnd = await db.getSetting("customBgGradientEnd");
        if (gradEnd) h.style.setProperty("--custom-bg-grad-end", gradEnd);
        const gradAngle = await db.getSetting("customBgGradientAngle");
        if (gradAngle) h.style.setProperty("--custom-bg-grad-angle", `${gradAngle}deg`);
        // Dynamic Island restore
        const diColor = await db.getSetting("dynIslandColor");
        if (diColor) h.style.setProperty("--dyn-island-bg", diColor);
        const diBlur = await db.getSetting("dynIslandBlur");
        if (diBlur) h.style.setProperty("--dyn-island-blur", `${diBlur}px`);
        const diOpacity = await db.getSetting("dynIslandOpacity");
        if (diOpacity) h.style.setProperty("--dyn-island-opacity", `${Number(diOpacity) / 100}`);
        const diSize = await db.getSetting("dynIslandSize");
        if (diSize) h.style.setProperty("--dyn-island-width", `${diSize}px`);
      };
      await restoreTheme();
      const savedVol = await db.getSetting("volume");

      // ── Restore Discord Rich Presence ──
      const discordRpc = await db.getSetting("discordRpc");
      if (discordRpc === "true") {
        DiscordRpcService.getInstance().enable().catch(err => {
          console.warn("[NeedMusic] Discord RPC auto-enable failed:", err);
        });
      }

      setTracks(LibraryManager.getInstance().getAllTracks());
      engine.subscribe({
        onStateChange: (s) => setPlayer((p) => ({ ...p, playbackState: s })),
        onTrackChange: (t) => setPlayer((p) => ({
          ...p, currentTrack: t, currentTimeSecs: 0,
          durationSecs: t?.durationSecs ?? p.durationSecs,
          isFavorite: (t as Track)?.isFavorite ?? false,
        })),
        onProgressChange: (cur, dur) => setPlayer((p) => ({
          ...p,
          currentTimeSecs: cur,
          durationSecs: dur > 0 ? dur : p.durationSecs,
        })),
        onVolumeChange: (v) => {
          setPlayer((p) => ({ ...p, volume: v }));
          db.setSetting("volume", String(v));
        },
      });

      // Restore saved volume AFTER subscribing so onVolumeChange fires.
      if (savedVol) engine.setVolume(Number(savedVol));
      if (bgCanvasRef.current) BackgroundEngine.getInstance().mount(bgCanvasRef.current);

      // ── Dynamic Island Tauri Event Bridge ──
      // Emit player state to the separate island window periodically.
      const emitIslandState = async () => {
        try {
          const { emit } = await import("@tauri-apps/api/event");
          const q = engine.queueTracks;
          let nextTrack: { title: string; artist: string } | null = null;
          if (q.length > 0 && engine.currentIndex_ >= 0) {
            const nextIdx = engine.currentIndex_ + 1;
            if (nextIdx < q.length) {
              const nt = q[nextIdx];
              if (nt) nextTrack = { title: nt.title, artist: nt.displayArtist() };
            } else if (engine.repeatMode === RepeatMode.Playlist) {
              const nt = q[0];
              if (nt) nextTrack = { title: nt.title, artist: nt.displayArtist() };
            }
          }
          const currentTrack = engine.currentTrack;
          const curTime = engine.getCurrentTime();
          await emit("island-state", {
            currentTrack: currentTrack ? {
              title: currentTrack.title,
              artist: currentTrack.displayArtist(),
              hasArtwork: currentTrack.hasArtwork,
            } : null,
            playbackState: engine.state,
            currentTimeSecs: curTime,
            durationSecs: currentTrack?.durationSecs ?? 0,
            nextTrack,
          });
        } catch { /* island window may not exist yet */ }
      };

      // Periodic comprehensive state update
      islandInterval = setInterval(emitIslandState, 500);

      // Also listen for commands from the island window
      try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen<{ command: string }>("island-command", (event) => {
          const cmd = event.payload.command;
          switch (cmd) {
            case "play": engine.resume(); break;
            case "pause": engine.pause(); break;
            case "next": engine.next(); break;
            case "previous": engine.previous(); break;
          }
        });
      } catch { /* ignore */ }

      // ── End Island Bridge ──

      let gamingVolume = 1;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();

      // Show window now that the webview has loaded content.
      // (window starts hidden to avoid "refused to connect" flash.)
      await win.show();
      await win.setFocus();

      // Sync close-to-tray setting from DB to Rust backend.
      try {
        const closeToTrayVal = await db.getSetting("closeToTray");
        await invoke("set_close_to_tray", { enable: closeToTrayVal !== "false" });
      } catch { /* ignore if command not available */ }

      await win.onFocusChanged(async ({ payload: focused }) => {
        const gamingOn = await db.getSetting("gamingDetect");
        if (gamingOn !== "true") return;
        if (!focused) {
          gamingVolume = engine.volume;
          engine.setVolume(gamingVolume * 0.25);
          setPlayer((p) => ({ ...p, volume: gamingVolume * 0.25 }));
        } else {
          engine.setVolume(gamingVolume);
          setPlayer((p) => ({ ...p, volume: gamingVolume }));
        }
      });
      clearTimeout(timeoutId);
      setReady(true);
      console.log("[NeedMusic] App ready.");
    }).catch((err) => {
      clearTimeout(timeoutId);
      const msg = String(err);
      console.error("[NeedMusic] Initialization error:", msg, err);
      setError(msg);
    });
    return () => { clearTimeout(timeoutId); if (islandInterval) clearInterval(islandInterval); BackgroundEngine.getInstance().unmount(); };
  }, [engine]);

  const filteredTracks = useMemo(() => {
    let list = tracks;
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((t) => {
      switch (filterField) {
        case "Title": return t.title.toLowerCase().includes(q);
        case "Artist": return t.artist.toLowerCase().includes(q);
        case "Album": return t.album.toLowerCase().includes(q);
        case "Genre": return t.genre.toLowerCase().includes(q);
        default: return t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q);
      }
    });
  }, [tracks, searchQuery, filterField]);

  const handlePlayTrack = useCallback(async (track: Track) => {
    await engine.play(track);
  }, [engine]);

  const handleToggleFavorite = useCallback(async (track: Track) => {
    track.isFavorite = !track.isFavorite;
    await DatabaseManager.getInstance().setFavorite(track.id, track.isFavorite);
    setTracks([...tracks]);
    if (player.currentTrack?.id === track.id) setPlayer((p) => ({ ...p, isFavorite: track.isFavorite }));
  }, [tracks, player.currentTrack]);

  const handleRemoveTrack = useCallback(async (track: Track) => {
    // If currently playing this track, stop playback first.
    if (player.currentTrack?.id === track.id) {
      engine.stop();
    }
    await LibraryManager.getInstance().removeTrack(track.id);
    setTracks(LibraryManager.getInstance().getAllTracks());
  }, [player.currentTrack, engine]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    CustomContextMenu.getInstance().show(e.clientX, e.clientY, [
      { id: "play", label: "Play" }, { id: "pause", label: "Pause" },
      { separator: true }, { id: "next", label: "Next", shortcut: "Ctrl+→" },
      { id: "prev", label: "Previous", shortcut: "Ctrl+←" },
    ] as ContextMenuEntry[], (id) => {
      switch (id) { case "play": engine.resume(); break; case "pause": engine.pause(); break; case "next": engine.next(); break; case "prev": engine.previous(); break; }
    });
  }, [engine]);

  if (error) return (
    <div className="splash-screen" style={{ color: "#e94560", flexDirection: "column", gap: "16px" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}><IconMusic size={32} style={{ marginRight: 8 }} />NeedMusic</h1>
        <p style={{ color: "#e94560", marginBottom: 8, fontWeight: 600 }}>Startup Failed</p>
        <p style={{ color: "#888", fontSize: 13, maxWidth: 400, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{error}</p>
        <button
          onClick={() => { setError(null); setReady(false); window.location.reload(); }}
          style={{
            marginTop: 16, padding: "8px 20px", background: "#e94560", color: "#fff",
            border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
  if (!ready) return (
    <div className="splash-screen">
      <div style={{ textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}><IconMusic size={32} style={{ marginRight: 8 }} />NeedMusic</h1>
        <p style={{ color: "#888", fontSize: 14 }}>Initializing...</p>
        <p style={{ color: "#555", fontSize: 11, marginTop: 4 }}>Setting up database and audio engine</p>
        <div className="splash-spinner" />
      </div>
    </div>
  );

  const ct = player.currentTrack;
  const isPlaying = player.playbackState === PlaybackState.Playing;

  return (
    <div className="app-wrapper">
      <CustomTitleBar />
      <div className="custom-bg-layer" />
      <canvas ref={bgCanvasRef} className={`bg-canvas ${bgClass}`} />
      <div className="app-layout" onContextMenu={handleContextMenu}>
        <nav className="icon-sidebar">
          <div className={`icon-nav-item ${activeTab === "Tracks" ? "active" : ""}`} onClick={() => setActiveTab("Tracks")} title="Tracks"><IconLibrary size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Albums" ? "active" : ""}`} onClick={() => setActiveTab("Albums")} title="Albums"><IconDisc size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Artists" ? "active" : ""}`} onClick={() => setActiveTab("Artists")} title="Artists"><IconMic size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Playlists" ? "active" : ""}`} onClick={() => setActiveTab("Playlists")} title="Playlists"><IconPlaylist size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Online" ? "active" : ""}`} onClick={() => setActiveTab("Online")} title="Online"><IconGlobe size={18} /></div>
          <div className="icon-nav-spacer" />
          <div className={`icon-nav-item ${activeTab === "Settings" ? "active" : ""}`} onClick={() => setActiveTab("Settings")} title="Settings"><IconSettings size={18} /></div>
        </nav>
        <div className="main-area">
          {/* Inline search bar */}
          {(activeTab === "Tracks" || activeTab === "Albums" || activeTab === "Artists") && (
            <div className="content-search-bar">
              <select
                className="filter-select"
                value={filterField}
                onChange={(e) => setFilterField(e.target.value)}
              >
                {FILTERS.map((f) => (
                  <option key={f} value={f}>Filter: {f}</option>
                ))}
              </select>
              <input
                className="search-input"
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          )}
          <div className="content-area">
            {activeTab === "Albums" ? <AlbumsView tracks={filteredTracks} onPlay={handlePlayTrack} /> :
             activeTab === "Artists" ? <ArtistsView tracks={filteredTracks} /> :
             activeTab === "Playlists" ? <PlaylistsView tracks={tracks} /> :
             activeTab === "Online" ? (
               <OnlineSearchView
                 onTrackSaved={() => setTracks(LibraryManager.getInstance().getAllTracks())}
               />
             ) :
             activeTab === "Settings" ? <SettingsView onTracksLoaded={setTracks} /> :
             <TrackListView tracks={filteredTracks} currentTrack={ct} onPlay={handlePlayTrack} onToggleFav={handleToggleFavorite} onRemove={handleRemoveTrack} />}
          </div>
        </div>
        <QueuePanel />
      </div>
      <div className="player-bar frosted-panel">
        <div className="player-left">
          <div className="player-artwork">{ct?.hasArtwork ? <IconImage size={20} /> : <IconMusic size={20} />}</div>
          {ct ? (
            <div className="player-track-details">
              <MarqueeText className="player-title">{ct.title}</MarqueeText>
              <MarqueeText className="player-artist">{ct.displayArtist()}</MarqueeText>
              <div className="player-metadata">{(ct as Track).audioMetadata()}</div>
            </div>
          ) : (
            <div className="player-track-details">
              <div className="player-title" style={{ color: "#555" }}>No track playing</div>
              <div className="player-artist" style={{ color: "#444" }}>Select a track</div>
            </div>
          )}
        </div>
        <div className="player-center">
          <div className="player-controls">
            <button className="ctrl-btn" onClick={() => ct && handleToggleFavorite(ct as Track)} title={player.isFavorite ? "Unfavorite" : "Favorite"}>{player.isFavorite ? <IconHeartFill size={16} /> : <IconHeart size={16} />}</button>
            <button className="ctrl-btn" onClick={() => engine.previous()} title="Previous"><IconPrevious size={16} /></button>
            <button className="ctrl-btn play-btn" onClick={() => isPlaying ? engine.pause() : engine.resume()} title={isPlaying ? "Pause" : "Play"}>{isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}</button>
            <button className="ctrl-btn" onClick={() => engine.next()} title="Next"><IconNext size={16} /></button>
            <button className="ctrl-btn" onClick={() => engine.stop()} title="Stop"><IconStop size={16} /></button>
          </div>
          <ProgressBar currentSecs={player.currentTimeSecs} totalSecs={player.durationSecs} onSeek={(s) => engine.seek(s)} />
        </div>
        <div className="player-right">
          {/* Playback Speed */}
          <select
            className="speed-select"
            value={player.playbackRate}
            onChange={(e) => {
              const rate = Number(e.target.value);
              engine.setPlaybackRate(rate);
              setPlayer((p) => ({ ...p, playbackRate: rate }));
            }}
            title={`Speed: ${player.playbackRate}x`}
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}x</option>
            ))}
          </select>
          <button className={`ctrl-btn ${player.repeatMode !== RepeatMode.Off ? "active" : ""}`}
            title={`Repeat: ${player.repeatMode === RepeatMode.Track ? "Track" : player.repeatMode === RepeatMode.Playlist ? "Playlist" : "Off"}`}
            onClick={() => {
              const modes = [RepeatMode.Off, RepeatMode.Playlist, RepeatMode.Track];
              engine.repeatMode = modes[(modes.indexOf(player.repeatMode) + 1) % 3];
              setPlayer((p) => ({ ...p, repeatMode: engine.repeatMode }));
            }}>
            {player.repeatMode === RepeatMode.Track ? <IconRepeatOne size={16} /> : player.repeatMode === RepeatMode.Playlist ? <IconRepeat size={16} /> : <IconRepeatOff size={16} />}
          </button>
          <button className={`ctrl-btn ${player.isShuffled ? "active" : ""}`}
            onClick={() => setPlayer((p) => ({ ...p, isShuffled: !p.isShuffled }))} title="Shuffle"><IconShuffle size={16} /></button>
          <div className="volume-slider">
            <span style={{ display: "flex", alignItems: "center" }}><IconVolume size={14} /></span>
            <input type="range" min="0" max="100" value={Math.round(player.volume * 100)}
              onChange={(e) => engine.setVolume(Number(e.target.value) / 100)}
              className="volume-range"
              title={`Volume: ${Math.round(player.volume * 100)}%`} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;

// ─── Sub-Views ────────────────────────────────────────

const TrackListView: React.FC<{ tracks: Track[]; currentTrack: ITrack | null; onPlay: (t: Track) => void; onToggleFav: (t: Track) => void; onRemove: (t: Track) => void }> =
  ({ tracks, currentTrack, onPlay, onToggleFav, onRemove }) => (
    <div className="track-list">
      <div className="track-list-header">
        <span className="col-fav">#</span><span className="col-title">Title</span>
        <span className="col-artist">Artist</span><span className="col-album">Album</span>
        <span className="col-dur"><IconClock size={12} style={{ marginRight: 2 }} /></span><span className="col-add" />
      </div>
      {tracks.length === 0 ? <div className="track-empty">No tracks found.</div> : tracks.map((t) => (
        <div key={t.id} className={`track-row ${currentTrack?.id === t.id ? "active" : ""}`} onDoubleClick={() => onPlay(t)}>
          <span className="col-fav fav-btn" onClick={(e) => { e.stopPropagation(); onToggleFav(t); }}>{t.isFavorite ? <IconHeartFill size={13} /> : <IconHeart size={13} />}</span>
          <span className="col-title"><span className="track-thumb">{t.hasArtwork ? <IconImage size={14} /> : <IconMusic size={14} />}</span><MarqueeText>{t.title}</MarqueeText></span>
          <span className="col-artist"><MarqueeText>{t.artist}</MarqueeText></span>
          <span className="col-album"><MarqueeText>{t.album}</MarqueeText></span>
          <span className="col-dur">{t.formatDuration()}</span>
          <span className="col-add" title="Add to queue" onClick={(e) => { e.stopPropagation(); PlaybackEngine.getInstance().enqueue(t); }}><IconPlus size={14} /></span>
          <span className="col-remove" title="Remove from library" onClick={(e) => { e.stopPropagation(); onRemove(t); }}><IconClose size={12} /></span>
        </div>
      ))}
    </div>
  );

const AlbumsView: React.FC<{ tracks: Track[]; onPlay: (t: Track) => void }> = ({ tracks, onPlay }) => {
  const albums = [...Album.groupByAlbum(tracks).values()];
  return (
    <div className="track-list">
      <div className="track-list-header"><span style={{ flex:1,paddingLeft:16 }}>Album</span><span style={{ width:180 }}>Artist</span><span style={{ width:80,textAlign:"right",paddingRight:16 }}>Tracks</span></div>
      {albums.length === 0 ? <div className="track-empty">No albums.</div> : albums.map((a) => (
        <div key={a.title + a.artist} className="track-row" onDoubleClick={() => a.tracks[0] && onPlay(a.tracks[0])}>
          <span style={{ flex:1 }}><IconDisc size={16} style={{ marginRight: 6 }} />{a.title}</span>
          <span style={{ width:180,color:"#888" }}>{a.artist}</span>
          <span style={{ width:80,textAlign:"right",color:"#555",paddingRight:16 }}>{a.trackCount}</span>
        </div>
      ))}
    </div>
  );
};

const ArtistsView: React.FC<{ tracks: Track[] }> = ({ tracks }) => {
  const artists = [...Artist.groupByArtist(tracks).values()];
  return (
    <div className="track-list">
      <div className="track-list-header"><span style={{ flex:1,paddingLeft:16 }}>Artist</span><span style={{ width:140,textAlign:"right",paddingRight:16 }}>Albums / Tracks</span></div>
      {artists.length === 0 ? <div className="track-empty">No artists.</div> : artists.map((a) => (
        <div key={a.name} className="track-row">
          <span style={{ flex:1 }}><IconMic size={16} style={{ marginRight: 6 }} />{a.name}</span>
          <span style={{ width:140,textAlign:"right",color:"#555",paddingRight:16 }}>{a.albumCount} albums / {a.trackCount} tracks</span>
        </div>
      ))}
    </div>
  );
};
