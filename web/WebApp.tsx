import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { PlaybackEngine, PlaybackState, RepeatMode } from "@core/services/PlaybackEngine";
import type { ITrack, PlayerState } from "@core/interfaces";
import { BackgroundEngine } from "@core/utils/BackgroundEngine";
import ProgressBar from "@ui/components/ProgressBar";
import PlaylistsView from "@ui/components/PlaylistsView";
import QueuePanel from "@ui/components/QueuePanel";
import MarqueeText from "@ui/components/MarqueeText";
import {
  IconLibrary, IconHeart, IconHeartFill, IconPlaylist,
  IconMusic, IconImage, IconPrevious, IconPlay, IconPause, IconNext, IconStop,
  IconRepeatOff, IconRepeat, IconRepeatOne, IconShuffle, IconVolume,
  IconClock, IconPlus, IconClose, IconGlobe, IconSettings, IconUpload, IconAlert,
} from "@ui/components/Icons";
import { initWebPlayer, webTrackStore, toPlayableTrack, TrackData } from "./bootstrap";
import "../src/ui/styles/design-tokens.css";
import "../src/ui/styles/global.css";

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const FILTERS = ["All", "Title", "Artist", "Album", "Genre"];

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
          <div className={`icon-nav-item ${activeTab === "Online" ? "active" : ""}`} onClick={() => setActiveTab("Online")} title="Online"><IconGlobe size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Playlists" ? "active" : ""}`} onClick={() => setActiveTab("Playlists")} title="Playlists"><IconPlaylist size={18} /></div>
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
            {activeTab === "Online" ? (
              <WebOnlineSearch onPlayTrack={handlePlayTrack} />
            ) : activeTab === "Playlists" ? (
              <PlaylistsView tracks={[]} />
            ) : activeTab === "Settings" ? (
              <WebSettingsView />
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
        <QueuePanel />
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
      <div key={t.id} className={`track-row ${currentTrack && (currentTrack as any).id === t.id ? "active" : ""}`} onDoubleClick={() => onPlay(t)}>
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

const WebSettingsView: React.FC = () => {
  const [theme, setTheme] = useState(localStorage.getItem("needmusic:theme") || "dark");
  const applyTheme = (t: string) => {
    setTheme(t);
    localStorage.setItem("needmusic:theme", t);
    const h = document.documentElement;
    h.classList.remove("theme-dark", "theme-light");
    h.classList.add(`theme-${t}`);
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

function formatDuration(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Web Online Search ──────────────────────────────

interface BilibiliItem {
  bvid: string;
  title: string;
  author: string;
  duration: string;
  duration_secs: number;
  cover_url: string;
}

const WebOnlineSearch: React.FC<{ onPlayTrack: (td: TrackData) => void }> = ({ onPlayTrack }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BilibiliItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    try {
      const resp = await fetch(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}`
      );
      const json = await resp.json();
      if (json.code !== 0) throw new Error(json.message || "Search failed");
      const items: BilibiliItem[] = (json.data?.result || []).map((r: any) => ({
        bvid: r.bvid,
        title: r.title?.replace(/<[^>]+>/g, "") ?? "Untitled",
        author: r.author ?? "Unknown",
        duration: r.duration ?? "0:00",
        duration_secs: 0,
        cover_url: r.pic ?? "",
      }));
      setResults(items);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handlePlay = useCallback(async (item: BilibiliItem) => {
    try {
      // Try to get audio URL via a CORS-friendly Bilibili API.
      const infoResp = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${item.bvid}`
      );
      const infoJson = await infoResp.json();
      const cid = infoJson.data?.cid;
      if (!cid) throw new Error("Could not get video cid");

      const playResp = await fetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${item.bvid}&cid=${cid}&qn=0&fnval=16`
      );
      const playJson = await playResp.json();
      const audioUrl = playJson.data?.dash?.audio?.[0]?.baseUrl
        || playJson.data?.dash?.audio?.[0]?.base_url;

      if (!audioUrl) throw new Error("No audio stream available");

      const td: TrackData = {
        id: `bl-${item.bvid}`,
        title: item.title,
        artist: item.author,
        album: "Bilibili",
        albumArtist: "",
        durationSecs: item.duration_secs || 0,
        trackNumber: null,
        discNumber: null,
        genre: "Online",
        year: null,
        codec: "m4a",
        hasArtwork: !!item.cover_url,
        dateAdded: new Date(),
        isFavorite: false,
        audioUrl,
        artworkUrl: item.cover_url,
        sourceName: `Bilibili: ${item.title}`,
      };
      onPlayTrack(td);
    } catch (e: any) {
      console.error("Play online failed:", e);
      setError(String(e));
    }
  }, [onPlayTrack]);

  return (
    <div className="track-list" style={{ padding: 12 }}>
      <div className="content-search-bar">
        <input
          className="search-input"
          type="text"
          placeholder="Search Bilibili..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
        />
        <button
          onClick={doSearch}
          disabled={loading}
          style={{
            padding: "6px 16px", background: "#e94560", color: "#fff",
            border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600,
          }}
        >
          {loading ? "..." : "Search"}
        </button>
      </div>
      {error && (
        <div style={{ color: "#e94560", padding: "8px 0", display: "flex", alignItems: "center", gap: 6 }}>
          <IconAlert size={14} /> {error}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {results.map((item) => (
          <div
            key={item.bvid}
            className="track-row"
            onDoubleClick={() => handlePlay(item)}
            style={{ cursor: "pointer" }}
          >
            <span className="col-fav">
              {item.cover_url ? (
                <img src={item.cover_url} alt="" style={{ width: 28, height: 28, borderRadius: 3, objectFit: "cover" }} referrerPolicy="no-referrer" />
              ) : (
                <IconMusic size={14} />
              )}
            </span>
            <span className="col-title">
              <MarqueeText>{item.title}</MarqueeText>
            </span>
            <span className="col-artist"><MarqueeText>{item.author}</MarqueeText></span>
            <span className="col-album" />
            <span className="col-dur">{item.duration}</span>
            <span className="col-add" title="Play" onClick={(e) => { e.stopPropagation(); handlePlay(item); }}>
              <IconPlay size={13} />
            </span>
          </div>
        ))}
        {results.length === 0 && !loading && (
          <div className="track-empty">Search for music on Bilibili.</div>
        )}
      </div>
    </div>
  );
};

export default WebApp;
