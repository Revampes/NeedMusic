import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { PlaybackEngine, PlaybackState, RepeatMode } from "@core/services/PlaybackEngine";
import type { ITrack, PlayerState } from "@core/interfaces";
import { BackgroundEngine } from "@core/utils/BackgroundEngine";
import { DragBridge } from "@core/services/DragBridge";
import ProgressBar from "@ui/components/ProgressBar";
import QueuePanel from "@ui/components/QueuePanel";
import MarqueeText from "@ui/components/MarqueeText";
import {
  IconLibrary, IconHeart, IconHeartFill,
  IconMusic, IconImage, IconPrevious, IconPlay, IconPause, IconNext, IconStop,
  IconRepeatOff, IconRepeat, IconRepeatOne, IconShuffle, IconVolume,
  IconClock, IconPlus, IconClose, IconGlobe, IconSettings, IconUpload, IconAlert,
  IconPlaylist,
} from "@ui/components/Icons";
import { initWebPlayer, webTrackStore, toPlayableTrack, TrackData } from "./bootstrap";
import "../src/ui/styles/design-tokens.css";
import "../src/ui/styles/global.css";

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const FILTERS = ["All", "Title", "Artist", "Album", "Genre"];

/**
 * Build a LAN server URL that keeps the `?token=` from the shared address
 * the user pasted (e.g. http://192.168.1.10:17963/?token=abc) while pointing
 * at a concrete endpoint.
 */
function lanApi(lanUrl: string, pathAndQuery: string): string {
  try {
    const u = new URL(lanUrl);
    const token = u.searchParams.get("token") || "";
    const [path, query] = pathAndQuery.split("?");
    u.pathname = path;
    u.search = "";
    if (token) u.searchParams.set("token", token);
    if (query) {
      for (const pair of query.split("&")) {
        const [k, v] = pair.split("=");
        if (k) u.searchParams.set(k, decodeURIComponent(v || ""));
      }
    }
    return u.toString();
  } catch {
    return `${lanUrl.replace(/\/+$/, "")}${pathAndQuery}`;
  }
}

const WebApp: React.FC = () => {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackData[]>([]);
  const [activeTab, setActiveTab] = useState("Tracks");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterField, setFilterField] = useState("All");
  const [player, setPlayer] = useState<PlayerState>({
    currentTrack: null, playbackState: PlaybackState.Idle,
    currentTimeSecs: 0, durationSecs: 0, volume: 1, playbackRate: 1,
    repeatMode: RepeatMode.Off, isShuffled: false, isFavorite: false, buffering: false,
  });
  const engine = useMemo(() => PlaybackEngine.getInstance(), []);

  // ── LAN Sync (experimental): connect to the desktop server on the same Wi-Fi ──
  const [lanUrl, setLanUrl] = useState(() => {
    try { return localStorage.getItem("needmusic:lanUrl") || ""; } catch { return ""; }
  });

  // ── Initialize ────────────────────────────────────
  useEffect(() => {
    try {
      initWebPlayer();
      // Restore settings from localStorage.
      const savedVol = localStorage.getItem("needmusic:volume");
      if (savedVol) engine.setVolume(Number(savedVol));
      const savedRate = localStorage.getItem("needmusic:playbackRate");
      if (savedRate) engine.setPlaybackRate(Number(savedRate));
      // Restore tracks from localStorage.
      try {
        const saved = localStorage.getItem("needmusic:tracks");
        if (saved) {
          const parsed: TrackData[] = JSON.parse(saved);
          for (const t of parsed) {
            t.dateAdded = new Date(t.dateAdded);
          }
          webTrackStore.addTracks(parsed);
          setTracks(webTrackStore.getAll());
        }
      } catch { /* ignore parse errors */ }

      if (bgCanvasRef.current) BackgroundEngine.getInstance().mount(bgCanvasRef.current);
      setReady(true);
    } catch (err: any) {
      setError(String(err));
    }

    return () => { BackgroundEngine.getInstance().unmount(); };
  }, [engine]);

  // ── Observer: sync player state to React ──────────
  useEffect(() => {
    const unsub = engine.subscribe({
      onStateChange(state) {
        setPlayer((p) => ({ ...p, playbackState: state }));
      },
      onTrackChange(track) {
        setPlayer((p) => ({
          ...p,
          currentTrack: track,
          durationSecs: track?.durationSecs ?? 0,
          currentTimeSecs: 0,
          isFavorite: (track as any)?.isFavorite ?? false,
        }));
      },
      onProgressChange(currentSecs, totalSecs) {
        setPlayer((p) => ({ ...p, currentTimeSecs: currentSecs, durationSecs: totalSecs }));
      },
      onVolumeChange(volume) {
        setPlayer((p) => ({ ...p, volume }));
      },
    });
    return unsub;
  }, [engine]);

  // ── Persist tracks to localStorage ────────────────
  const persistTracks = useCallback((ts: TrackData[]) => {
    setTracks(ts);
    try {
      localStorage.setItem("needmusic:tracks", JSON.stringify(ts));
    } catch { /* quota exceeded */ }
  }, []);

  // ── Filter/Search ─────────────────────────────────
  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return tracks;
    const q = searchQuery.toLowerCase();
    return tracks.filter((t) => {
      switch (filterField) {
        case "Title": return t.title.toLowerCase().includes(q);
        case "Artist": return t.artist.toLowerCase().includes(q);
        case "Album": return t.album.toLowerCase().includes(q);
        case "Genre": return t.genre.toLowerCase().includes(q);
        default: return t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q);
      }
    });
  }, [tracks, searchQuery, filterField]);

  // ── File Import ───────────────────────────────────
  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newTracks: TrackData[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Only accept audio files.
      if (!file.type.startsWith("audio/") && !file.name.match(/\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|aiff)$/i)) continue;

      const blobUrl = URL.createObjectURL(file);
      // Try to get duration from the audio element.
      let durationSecs = 0;
      try {
        durationSecs = await new Promise<number>((resolve) => {
          const audio = new Audio();
          audio.src = blobUrl;
          audio.addEventListener("loadedmetadata", () => {
            resolve(isFinite(audio.duration) ? audio.duration : 0);
          });
          audio.addEventListener("error", () => resolve(0));
        });
      } catch { /* ignore */ }

      const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp3";
      const id = `web-${Date.now()}-${i}-${file.name}`;
      newTracks.push({
        id,
        title: file.name.replace(/\.[^.]+$/, ""),
        artist: "Unknown Artist",
        album: "Unknown Album",
        albumArtist: "",
        durationSecs,
        trackNumber: null,
        discNumber: null,
        genre: "",
        year: null,
        codec: ext,
        hasArtwork: false,
        dateAdded: new Date(),
        isFavorite: false,
        audioUrl: blobUrl,
        sourceName: file.name,
      });
    }

    if (newTracks.length > 0) {
      webTrackStore.addTracks(newTracks);
      const all = webTrackStore.getAll();
      persistTracks(all);
    }
    // Reset input so the same files can be re-imported.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [persistTracks]);

  // ── Playback Handlers ─────────────────────────────
  const handlePlayTrack = useCallback(async (td: TrackData) => {
    const playable = toPlayableTrack(td);
    await engine.play(playable as any);
  }, [engine]);

  const handleToggleFavorite = useCallback((td: TrackData) => {
    td.isFavorite = !td.isFavorite;
    webTrackStore.addTrack(td); // update in store
    const all = webTrackStore.getAll();
    persistTracks(all);
    if (player.currentTrack && (player.currentTrack as any).id === td.id) {
      setPlayer((p) => ({ ...p, isFavorite: td.isFavorite }));
    }
  }, [persistTracks, player.currentTrack]);

  const handleRemoveTrack = useCallback((td: TrackData) => {
    if (player.currentTrack && (player.currentTrack as any).id === td.id) {
      engine.stop();
    }
    webTrackStore.removeTrack(td.id);
    const all = webTrackStore.getAll();
    persistTracks(all);
  }, [persistTracks, player.currentTrack, engine]);

  // ── Splash / Error ────────────────────────────────
  if (error) return (
    <div className="splash-screen" style={{ color: "#e94560", flexDirection: "column", gap: "16px" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}><IconMusic size={32} style={{ marginRight: 8 }} />NeedMusic Web</h1>
        <p style={{ color: "#e94560", marginBottom: 8, fontWeight: 600 }}>Startup Failed</p>
        <p style={{ color: "#888", fontSize: 13, maxWidth: 400, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{error}</p>
        <button
          onClick={() => { setError(null); setReady(false); window.location.reload(); }}
          style={{ marginTop: 16, padding: "8px 20px", background: "#e94560", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 }}
        >Retry</button>
      </div>
    </div>
  );
  if (!ready) return (
    <div className="splash-screen">
      <div style={{ textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}><IconMusic size={32} style={{ marginRight: 8 }} />NeedMusic Web</h1>
        <p style={{ color: "#888", fontSize: 14 }}>Initializing...</p>
        <div className="splash-spinner" />
      </div>
    </div>
  );

  const ct = player.currentTrack;
  const isPlaying = player.playbackState === PlaybackState.Playing;

  return (
    <div className="app-wrapper">
      <div className="custom-bg-layer" />
      <canvas ref={bgCanvasRef} className="bg-canvas" />
      <div className="app-layout">
        <nav className="icon-sidebar">
          <div className={`icon-nav-item ${activeTab === "Tracks" ? "active" : ""}`} onClick={() => setActiveTab("Tracks")} title="Tracks"><IconLibrary size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Playlists" ? "active" : ""}`} onClick={() => setActiveTab("Playlists")} title="Playlists"><IconPlaylist size={18} /></div>
          {lanUrl && (
            <div className={`icon-nav-item ${activeTab === "Online" ? "active" : ""}`} onClick={() => setActiveTab("Online")} title="Online Search (via desktop)"><IconGlobe size={18} /></div>
          )}
          <div className="icon-nav-spacer" />
          <div className={`icon-nav-item ${activeTab === "Settings" ? "active" : ""}`} onClick={() => setActiveTab("Settings")} title="Settings"><IconSettings size={18} /></div>
          {/* Import button */}
          <div className="icon-nav-item" onClick={() => fileInputRef.current?.click()} title="Import Music">
            <IconUpload size={18} />
          </div>
        </nav>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.flac,.m4a,.aac,.ogg,.opus,.wav,.wma,.aiff"
          multiple
          onChange={handleFileImport}
          style={{ display: "none" }}
        />
        <div className="main-area">
          {/* Search bar */}
          {(activeTab === "Tracks") && (
            <div className="content-search-bar">
              <select className="filter-select" value={filterField} onChange={(e) => setFilterField(e.target.value)}>
                {FILTERS.map((f) => (<option key={f} value={f}>Filter: {f}</option>))}
              </select>
              <input className="search-input" type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>
          )}
          <div className="content-area">
            {activeTab === "Online" && lanUrl ? (
              <WebOnlineSearch lanUrl={lanUrl} onPlay={handlePlayTrack} />
            ) : activeTab === "Playlists" ? (
              <WebPlaylistsView tracks={tracks} onPlay={handlePlayTrack} />
            ) : activeTab === "Settings" ? (
              <WebSettingsView
                lanUrl={lanUrl}
                onConnect={(url) => {
                  setLanUrl(url);
                  try { localStorage.setItem("needmusic:lanUrl", url); } catch { /* ignore */ }
                  setTracks(webTrackStore.getAll());
                }}
                onDisconnect={() => {
                  setLanUrl("");
                  try { localStorage.removeItem("needmusic:lanUrl"); } catch { /* ignore */ }
                }}
              />
            ) : (
              <TrackListView
                tracks={filteredTracks}
                currentTrack={ct}
                onPlay={handlePlayTrack}
                onToggleFav={handleToggleFavorite}
                onRemove={handleRemoveTrack}
              />
            )}
          </div>
        </div>
        <QueuePanel libraryTracks={tracks as any} />
      </div>
      {/* Player Bar */}
      <div className="player-bar frosted-panel">
        <div className="player-left">
          <div className="player-artwork">{ct && (ct as any).hasArtwork ? <IconImage size={20} /> : <IconMusic size={20} />}</div>
          {ct ? (
            <div className="player-track-details">
              <MarqueeText className="player-title">{ct.title}</MarqueeText>
              <MarqueeText className="player-artist">{ct.displayArtist()}</MarqueeText>
            </div>
          ) : (
            <div className="player-track-details">
              <div className="player-title" style={{ color: "#555" }}>No track playing</div>
              <div className="player-artist" style={{ color: "#444" }}>Select a track — or import files</div>
            </div>
          )}
        </div>
        <div className="player-center">
          <div className="player-controls">
            <button className="ctrl-btn" onClick={() => ct && handleToggleFavorite(tracks.find(t => (ct as any).id === t.id)!)} title={player.isFavorite ? "Unfavorite" : "Favorite"}>
              {player.isFavorite ? <IconHeartFill size={16} /> : <IconHeart size={16} />}
            </button>
            <button className="ctrl-btn" onClick={() => engine.previous()} title="Previous"><IconPrevious size={16} /></button>
            <button className="ctrl-btn play-btn" onClick={() => isPlaying ? engine.pause() : engine.resume()} title={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}
            </button>
            <button className="ctrl-btn" onClick={() => engine.next()} title="Next"><IconNext size={16} /></button>
            <button className="ctrl-btn" onClick={() => engine.stop()} title="Stop"><IconStop size={16} /></button>
          </div>
          <ProgressBar currentSecs={player.currentTimeSecs} totalSecs={player.durationSecs} onSeek={(s) => engine.seek(s)} />
        </div>
        <div className="player-right">
          <select className="speed-select" value={player.playbackRate} onChange={(e) => {
            const rate = Number(e.target.value);
            engine.setPlaybackRate(rate);
            setPlayer((p) => ({ ...p, playbackRate: rate }));
          }} title={`Speed: ${player.playbackRate}x`}>
            {SPEED_OPTIONS.map((s) => (<option key={s} value={s}>{s}x</option>))}
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
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                engine.setVolume(v);
                localStorage.setItem("needmusic:volume", String(v));
              }}
              className="volume-range" title={`Volume: ${Math.round(player.volume * 100)}%`} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Sub-Views ──────────────────────────────────────

const TrackListView: React.FC<{
  tracks: TrackData[];
  currentTrack: ITrack | null;
  onPlay: (t: TrackData) => void;
  onToggleFav: (t: TrackData) => void;
  onRemove: (t: TrackData) => void;
}> = ({ tracks, currentTrack, onPlay, onToggleFav, onRemove }) => (
  <div className="track-list">
    <div className="track-list-header">
      <span className="col-fav">#</span><span className="col-title">Title</span>
      <span className="col-artist">Artist</span><span className="col-album">Album</span>
      <span className="col-dur"><IconClock size={12} style={{ marginRight: 2 }} /></span><span className="col-add" />
    </div>
    {tracks.length === 0 ? (
      <div className="track-empty">
        No tracks yet. Click the <IconUpload size={14} /> upload button to import audio files.
      </div>
    ) : tracks.map((t) => (
      <div key={t.id} className={`track-row ${currentTrack && (currentTrack as any).id === t.id ? "active" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", t.id);
          e.dataTransfer.setData("Text", t.id);
          e.dataTransfer.effectAllowed = "copyMove";
          DragBridge.setDraggedTrackId(t.id);
        }}
        onDragEnd={() => DragBridge.clear()}
        onDoubleClick={() => onPlay(t)}>
        <span className="col-fav fav-btn" onClick={(e) => { e.stopPropagation(); onToggleFav(t); }}>
          {t.isFavorite ? <IconHeartFill size={13} /> : <IconHeart size={13} />}
        </span>
        <span className="col-title">
          <span className="track-thumb">{t.hasArtwork ? <IconImage size={14} /> : <IconMusic size={14} />}</span>
          <MarqueeText>{t.title}</MarqueeText>
        </span>
        <span className="col-artist"><MarqueeText>{t.artist}</MarqueeText></span>
        <span className="col-album"><MarqueeText>{t.album}</MarqueeText></span>
        <span className="col-dur">{formatDuration(t.durationSecs)}</span>
        <span className="col-add" title="Add to queue" onClick={(e) => { e.stopPropagation(); PlaybackEngine.getInstance().enqueue(toPlayableTrack(t) as any); }}>
          <IconPlus size={14} />
        </span>
        <span className="col-remove" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(t); }}>
          <IconClose size={12} />
        </span>
      </div>
    ))}
  </div>
);

const WebSettingsView: React.FC<{
  lanUrl: string;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
}> = ({ lanUrl, onConnect, onDisconnect }) => {
  const [theme, setTheme] = useState(localStorage.getItem("needmusic:theme") || "dark");
  const [serverUrl, setServerUrl] = useState(lanUrl);
  const [lanStatus, setLanStatus] = useState<string | null>(null);
  const [lanBusy, setLanBusy] = useState(false);

  const applyTheme = (t: string) => {
    setTheme(t);
    localStorage.setItem("needmusic:theme", t);
    const h = document.documentElement;
    h.classList.remove("theme-dark", "theme-light");
    h.classList.add(`theme-${t}`);
  };

  // Fetch the desktop library over the LAN and add its tracks locally.
  const connect = async () => {
    const url = serverUrl.trim().replace(/\/+$/, "");
    if (!url) return;
    setLanBusy(true);
    setLanStatus(null);
    try {
      const res = await fetch(lanApi(lanUrl, "/api/library"));
      if (!res.ok) throw new Error(`HTTP ${res.status} — is the desktop server running?`);
      const data = await res.json();
      const remoteTracks: TrackData[] = (data.tracks ?? []).map((t: any) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        albumArtist: t.artist,
        durationSecs: t.duration_secs || 0,
        trackNumber: null,
        discNumber: null,
        genre: "",
        year: null,
        codec: "mp3",
        hasArtwork: false,
        dateAdded: new Date(),
        isFavorite: false,
        audioUrl: lanApi(url, `/audio/${encodeURIComponent(t.id)}`),
        sourceName: `${t.title} (LAN)`,
      }));
      webTrackStore.addTracks(remoteTracks);
      try {
        localStorage.setItem("needmusic:tracks", JSON.stringify(webTrackStore.getAll()));
      } catch { /* quota */ }
      onConnect(url);
      setLanStatus(`Connected — ${remoteTracks.length} tracks synced from your computer.`);
    } catch (e) {
      setLanStatus(String(e));
    } finally {
      setLanBusy(false);
    }
  };

  return (
    <div className="track-list" style={{ padding: 24 }}>
      <h3 style={{ marginBottom: 16 }}>Settings</h3>
      <div style={{ marginBottom: 12 }}>
        <label style={{ marginRight: 12 }}>Theme:</label>
        <select value={theme} onChange={(e) => applyTheme(e.target.value)}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>

      {/* ── LAN Sync (experimental) ── */}
      <div style={{ marginBottom: 16, padding: 12, border: "1px solid #333", borderRadius: 8, background: "#14141f" }}>
        <h4 style={{ marginBottom: 8, fontSize: 14 }}>Sync with Computer <span style={{ color: "#888", fontSize: 11, fontWeight: 400 }}>(experimental)</span></h4>
        <p style={{ fontSize: 11, color: "#999", marginBottom: 8, lineHeight: 1.5 }}>
          On your computer open Settings → LAN Sync → Start Server, then paste the full address it shows
          (it contains a security token, e.g. <code style={{ color: "#ccc" }}>http://192.168.1.10:17963/?token=…</code>).
          Your phone and computer must be on the same Wi-Fi.
        </p>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://192.168.1.10:17963"
            inputMode="url"
            style={{ flex: 1, padding: "6px 8px", background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", borderRadius: 4, fontSize: 13 }}
          />
          <button
            onClick={connect}
            disabled={lanBusy || !serverUrl.trim()}
            style={{ padding: "6px 14px", background: lanUrl ? "#333" : "#e94560", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
          >
            {lanBusy ? "…" : lanUrl ? "Reconnect" : "Connect"}
          </button>
          {lanUrl && (
            <button
              onClick={() => {
                onDisconnect();
                setServerUrl("");
                setLanStatus("Disconnected. Synced tracks stay on this device.");
              }}
              style={{ padding: "6px 10px", background: "transparent", color: "#e94560", border: "1px solid #e94560", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
            >
              Disconnect
            </button>
          )}
        </div>
        {lanStatus && <p style={{ fontSize: 11, color: lanStatus.startsWith("Connected") ? "#4ecdc4" : "#e94560" }}>{lanStatus}</p>}
      </div>

      <button
        onClick={() => {
          webTrackStore.clear();
          localStorage.removeItem("needmusic:tracks");
          window.location.reload();
        }}
        style={{ padding: "6px 16px", background: "#e94560", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
      >
        Clear All Tracks
      </button>
    </div>
  );
};

// ─── Online search proxied through the desktop's LAN server ──

const WebOnlineSearch: React.FC<{ lanUrl: string; onPlay: (t: TrackData) => void }> = ({ lanUrl, onPlay }) => {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const res = await fetch(lanApi(lanUrl, `/online/search?q=${encodeURIComponent(query)}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Merge Bilibili + YouTube round-robin (same as the desktop).
      const bili: any[] = data.bilibili?.results ?? [];
      const yt: any[] = data.youtube?.results ?? [];
      const merged: any[] = [];
      const max = Math.max(bili.length, yt.length);
      for (let i = 0; i < max; i++) {
        if (i < bili.length) merged.push(bili[i]);
        if (i < yt.length) merged.push(yt[i]);
      }
      setResults(merged);
      if (merged.length === 0) setError("No results found. Try a different search term.");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const play = (item: any) => {
    // The desktop server downloads to its temp cache and streams the file.
    const idOrUrl = item.source === "youtube" ? item.url : item.bvid;
    const audioUrl = lanApi(
      lanUrl,
      `/online/audio?source=${encodeURIComponent(item.source)}` +
        `&id=${encodeURIComponent(idOrUrl)}` +
        `&title=${encodeURIComponent(item.title)}` +
        `&artist=${encodeURIComponent(item.author)}`
    );
    onPlay({
      id: `web-online-${item.source}-${item.id}`,
      title: item.title,
      artist: item.author,
      album: item.source === "youtube" ? "YouTube" : "Bilibili",
      albumArtist: item.author,
      durationSecs: item.duration_secs || 0,
      trackNumber: null,
      discNumber: null,
      genre: "Online",
      year: null,
      codec: "mp4",
      hasArtwork: false,
      dateAdded: new Date(),
      isFavorite: false,
      audioUrl,
      sourceName: item.title,
    });
  };

  return (
    <div className="online-search-view">
      <div className="online-search-bar">
        <input
          className="online-search-input"
          type="text"
          placeholder="Search Bilibili & YouTube (via your computer)..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          disabled={loading}
        />
        <button className="online-search-btn" onClick={search} disabled={loading || !q.trim()}>
          {loading ? "Searching..." : "Search"}
        </button>
      </div>
      {error && (
        <div className="online-error">
          <IconClose size={14} />
          <span>{error}</span>
        </div>
      )}
      <div className="online-results-list" style={{ paddingTop: 8 }}>
        {results.map((item) => (
          <div key={`${item.source}-${item.id}`} className="online-result-row">
            <div className="online-result-row-info">
              <div className="online-result-row-title">{item.title}</div>
              <div className="online-result-row-meta">
                <span className="online-result-row-author">{item.author}</span>
                <span className="online-result-row-duration">{item.duration}</span>
              </div>
            </div>
            <div className="online-result-row-actions">
              <button className="online-action-btn play" onClick={() => play(item)}>
                <IconPlay size={12} />
                Play
              </button>
            </div>
          </div>
        ))}
      </div>
      {!loading && results.length === 0 && !error && (
        <div className="online-empty">
          <IconGlobe size={32} />
          <p>Search music from Bilibili & YouTube — playback streams through your computer.</p>
        </div>
      )}
    </div>
  );
};

function formatDuration(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Web Playlists (localStorage-based, no Tauri DB) ──

interface WebPlaylist {
  id: string;
  name: string;
  trackIds: string[];
}

function loadPlaylists(): WebPlaylist[] {
  try { return JSON.parse(localStorage.getItem("needmusic:playlists") || "[]"); } catch { return []; }
}
function savePlaylists(pl: WebPlaylist[]): void {
  localStorage.setItem("needmusic:playlists", JSON.stringify(pl));
}

const WebPlaylistsView: React.FC<{ tracks: TrackData[]; onPlay: (t: TrackData) => void }> = ({ tracks, onPlay }) => {
  const [playlists, setPlaylists] = useState<WebPlaylist[]>(loadPlaylists);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragTrack, setDragTrack] = useState<string | null>(null);

  const createPlaylist = () => {
    const name = newName.trim() || "New Playlist";
    const pl: WebPlaylist = { id: `pl-${Date.now()}`, name, trackIds: [] };
    const updated = [...playlists, pl];
    setPlaylists(updated); savePlaylists(updated); setNewName("");
  };

  const addToPlaylist = (plId: string, trackId: string) => {
    const updated = playlists.map(p => p.id === plId ? { ...p, trackIds: [...p.trackIds.filter(id => id !== trackId), trackId] } : p);
    setPlaylists(updated); savePlaylists(updated);
  };

  const removeFromPlaylist = (plId: string, trackId: string) => {
    const updated = playlists.map(p => p.id === plId ? { ...p, trackIds: p.trackIds.filter(id => id !== trackId) } : p);
    setPlaylists(updated); savePlaylists(updated);
  };

  const deletePlaylist = (plId: string) => {
    const updated = playlists.filter(p => p.id !== plId);
    setPlaylists(updated); savePlaylists(updated);
    if (selected === plId) setSelected(null);
  };

  const sel = playlists.find(p => p.id === selected);
  const selTracks = sel ? sel.trackIds.map(id => tracks.find(t => t.id === id)).filter(Boolean) as TrackData[] : [];

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={{ width: 200, borderRight: "1px solid #222", padding: 8, overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New playlist..."
            style={{ flex: 1, padding: "4px 8px", background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", borderRadius: 4, fontSize: 12 }}
            onKeyDown={e => e.key === "Enter" && createPlaylist()} />
          <button onClick={createPlaylist} style={{ padding: "4px 8px", background: "#e94560", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}><IconPlus size={12} /></button>
        </div>
        {playlists.map(pl => (
          <div key={pl.id} onClick={() => setSelected(pl.id)}
            style={{ padding: "6px 8px", cursor: "pointer", borderRadius: 4, display: "flex", justifyContent: "space-between", alignItems: "center", background: selected === pl.id ? "#e9456020" : "transparent", color: selected === pl.id ? "#e94560" : "#aaa", fontSize: 13 }}>
            <span><IconPlaylist size={12} style={{ marginRight: 4 }} />{pl.name} ({pl.trackIds.length})</span>
            <span onClick={e => { e.stopPropagation(); deletePlaylist(pl.id); }} style={{ cursor: "pointer", opacity: 0.5 }}><IconClose size={10} /></span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {sel ? (
          <>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #222", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600 }}>{sel.name}</span>
              <span style={{ color: "#666", fontSize: 12 }}>{sel.trackIds.length} tracks</span>
            </div>
            {selTracks.map(t => (
              <div key={t.id} className="track-row" onDoubleClick={() => onPlay(t)} draggable onDragStart={() => setDragTrack(t.id)}>
                <span className="col-title"><IconMusic size={12} style={{ marginRight: 4 }} />{t.title}</span>
                <span className="col-artist">{t.artist}</span>
                <span className="col-dur">{formatDuration(t.durationSecs)}</span>
                <span className="col-remove" onClick={e => { e.stopPropagation(); removeFromPlaylist(sel.id, t.id); }}><IconClose size={12} /></span>
              </div>
            ))}
            <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragTrack) addToPlaylist(sel.id, dragTrack); setDragTrack(null); }}
              style={{ margin: 8, padding: 24, border: "2px dashed #333", borderRadius: 8, textAlign: "center", color: "#555", fontSize: 12 }}>
              Drop tracks here to add
            </div>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#555" }}>
            Select or create a playlist
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Mobile responsive styles ────────────────────────

const mobileStyles = `
@media (max-width: 768px) {
  .app-layout { flex-direction: column !important; }
  .icon-sidebar { flex-direction: row !important; width: 100% !important; height: auto !important; padding: 8px 0 !important; gap: 4px !important; justify-content: center !important; }
  .icon-nav-item { padding: 8px !important; }
  .main-area { width: 100% !important; }
  .player-bar { flex-direction: column !important; padding: 8px !important; gap: 8px !important; height: auto !important; }
  .player-left, .player-center, .player-right { width: 100% !important; justify-content: center !important; }
  .player-controls { justify-content: center !important; }
  .volume-slider { display: none !important; }
  .player-track-details { max-width: 200px !important; }
  .track-list-header { font-size: 11px !important; }
  .track-row { font-size: 12px !important; }
  .col-album, .col-artist { display: none !important; }
  .col-dur { width: 40px !important; }
  .content-search-bar { flex-wrap: wrap !important; }
}
@media (max-width: 480px) {
  .player-metadata { display: none !important; }
  .speed-select { display: none !important; }
  .ctrl-btn { padding: 4px !important; }
}
`;

if (typeof document !== "undefined") {
  const styleEl = document.createElement("style");
  styleEl.textContent = mobileStyles;
  document.head.appendChild(styleEl);
}

export default WebApp;
