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
  IconPlaylist, IconDownload, IconCheck, IconFolder,
} from "@ui/components/Icons";
import { initWebPlayer, webTrackStore, toPlayableTrack, TrackData } from "./bootstrap";
import {
  saveDownloadedAudio, getDownloadedAudio, removeDownloadedAudio,
} from "./downloads";
import "../src/ui/styles/design-tokens.css";
import "../src/ui/styles/global.css";

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const FILTERS = ["All", "Title", "Artist", "Album", "Genre"];
const SORT_OPTIONS = [
  { value: "default", label: "Default order" },
  { value: "title-az", label: "Title A–Z" },
  { value: "title-za", label: "Title Z–A" },
  { value: "artist-az", label: "Artist A–Z" },
  { value: "album-az", label: "Album A–Z" },
  { value: "duration-asc", label: "Duration (shortest)" },
  { value: "duration-desc", label: "Duration (longest)" },
  { value: "date-new", label: "Date added (newest)" },
];

/** Apply a sort mode to a track list (stable for "default"). */
function sortTracks<T extends { title: string; artist: string; album: string; durationSecs: number; dateAdded: Date | string }>(list: T[], mode: string): T[] {
  if (!mode || mode === "default") return list;
  const arr = [...list];
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  switch (mode) {
    case "title-az": return arr.sort((a, b) => cmp(a.title, b.title) || cmp(a.artist, b.artist));
    case "title-za": return arr.sort((a, b) => cmp(b.title, a.title) || cmp(a.artist, b.artist));
    case "artist-az": return arr.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.title, b.title));
    case "album-az": return arr.sort((a, b) => cmp(a.album, b.album) || cmp(a.title, b.title));
    case "duration-asc": return arr.sort((a, b) => (a.durationSecs || 0) - (b.durationSecs || 0));
    case "duration-desc": return arr.sort((a, b) => (b.durationSecs || 0) - (a.durationSecs || 0));
    case "date-new": return arr.sort((a, b) => new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime());
    default: return list;
  }
}

/** 1 MB download chunks — iOS Safari fails whole-file fetches of larger
 *  audio over HTTP while tiny range fetches work fine. */
const DL_CHUNK = 1024 * 1024;

/**
 * Download a complete file by requesting it in 1 MB Range chunks and stitching
 * the parts into one Blob. Returns a Blob even for large files on iOS.
 */
async function fetchFullFile(url: string): Promise<Blob> {
  // Learn the total size from a 1-byte range probe (the LAN server answers 206
  // with Content-Range; this is the same probe that already works on phones).
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
  let total = -1;
  if (probe.status === 206) {
    const m = (probe.headers.get("content-range") || "").match(/\/(\d+)$/);
    if (m) total = Number(m[1]);
  } else if (probe.ok) {
    // Server ignored the range header — it returned the whole file; use it.
    return await probe.blob();
  } else {
    throw new Error(`HTTP ${probe.status}`);
  }
  if (total <= 0) throw new Error("could not determine file size");

  const parts: Blob[] = [];
  let start = 0;
  while (start < total) {
    const end = Math.min(start + DL_CHUNK - 1, total - 1);
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const part = await res.blob();
    if (part.size === 0) break; // safety: avoid an infinite loop
    parts.push(part);
    start = end + 1;
  }
  return new Blob(parts);
}

/** Identify the REAL audio format from the file's magic bytes (not the extension). */
function sniffFormat(bytes: Uint8Array): string {  const str = (off: number, len: number) =>
    String.fromCharCode(...bytes.slice(off, off + len));
  if (bytes.length >= 12 && str(4, 4) === "ftyp") {
    const brand = str(8, 4);
    if (/M4A|M4B/i.test(brand)) return "M4A (AAC)";
    if (/isom|mp42|avc1/i.test(brand)) return "MP4 video container";
    return `MP4 container (${brand})`;
  }
  if (bytes.length >= 3 && str(0, 3) === "ID3") return "MP3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "MP3";
  if (bytes.length >= 4 && str(0, 4) === "fLaC") return "FLAC";
  if (bytes.length >= 4 && str(0, 4) === "RIFF") return "WAV";
  if (bytes.length >= 4 && str(0, 4) === "OggS") return "OGG/Opus";
  if (bytes.length >= 4 && str(0, 4) === "MAC ") return "APE";
  return "unknown format";
}

/** Map a sniffed format name to a file extension for "Save to Files". */
function formatToExt(format: string): string {
  if (/MP4 video|MP4 container/i.test(format)) return ".mp4";
  if (/M4A/i.test(format)) return ".m4a";
  if (/MP3/i.test(format)) return ".mp3";
  if (/FLAC/i.test(format)) return ".flac";
  if (/WAV/i.test(format)) return ".wav";
  if (/OGG|Opus/i.test(format)) return ".ogg";
  if (/APE/i.test(format)) return ".ape";
  return ".mp3";
}

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
  const [sortMode, setSortMode] = useState("default");
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
  const [lanStatus, setLanStatus] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  // True when this page is HTTPS but the LAN server is HTTP — browsers block
  // streaming from an insecure LAN address on a secure page (mixed content).
  const [lanMixedContent, setLanMixedContent] = useState(false);
  // Track id → local blob URL of a downloaded copy (plays without LAN).
  const downloadedRef = useRef(new Map<string, string>());
  // Track id → detected real format (from the file's magic bytes).
  const downloadedFormatRef = useRef(new Map<string, string>());
  // Track id currently being downloaded (for UI feedback).
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const isDownloaded = useCallback((id: string) => downloadedRef.current.has(id), []);

  /** Attach blob URLs from IndexedDB to tracks that were downloaded before. */
  const attachDownloadedBlobs = useCallback(async (list: TrackData[]) => {
    for (const td of list) {
      if (downloadedRef.current.has(td.id)) continue;
      try {
        const blob = await getDownloadedAudio(td.id);
        if (blob) downloadedRef.current.set(td.id, URL.createObjectURL(blob));
      } catch { /* not downloaded / storage unavailable */ }
    }
  }, []);

  /** Download a track to the phone (fetch → IndexedDB → local blob URL). */
  const downloadTrack = useCallback(async (td: TrackData): Promise<string> => {
    const cached = downloadedRef.current.get(td.id);
    if (cached) return cached;
    if (!td.audioUrl) throw new Error("this track has no source to download");
    setDownloadingId(td.id);
    try {
      // Chunked Range download — iOS Safari can't fetch whole audio files
      // over HTTP, but handles many small range requests without issue.
      const blob = await fetchFullFile(td.audioUrl);
      // Sniff the REAL format from the file's magic bytes — the extension can
      // lie (e.g. an MP4 container named .mp3), which is why iOS refuses it.
      try {
        const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
        downloadedFormatRef.current.set(td.id, sniffFormat(head));
      } catch { /* ignore */ }
      const url = URL.createObjectURL(blob);
      downloadedRef.current.set(td.id, url);
      try { await saveDownloadedAudio(td.id, blob); } catch { /* storage full — playable this session only */ }
      return url;
    } finally {
      setDownloadingId(null);
    }
  }, []);

  /** Download every track in the given list to the phone. */
  const handleDownloadAll = useCallback(async (list: TrackData[]) => {
    const pending = list.filter((td) => !downloadedRef.current.has(td.id) && td.audioUrl);
    for (const td of pending) {
      try { await downloadTrack(td); } catch { /* skip failed tracks */ }
    }
  }, [downloadTrack]);

  /** Download the track as a REAL file the user can find in the Files app. */
  const saveTrackToFiles = useCallback(async (td: TrackData) => {
    try {
      const url = await downloadTrack(td); // gets/fetches the local blob
      const res = await fetch(url);
      const blob = await res.blob();
      const ext = formatToExt(downloadedFormatRef.current.get(td.id) || "");
      const base = (td.title || "track").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
      const a = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = `${base}${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (e: any) {
      setPlayError(`Couldn't save "${td.title}": ${(e && e.message) || e}`);
    }
  }, [downloadTrack]);

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

      // Restore downloaded copies from IndexedDB so previously downloaded
      // tracks play locally (no LAN needed).
      attachDownloadedBlobs(webTrackStore.getAll()).catch(() => {});

      // Auto-connect when opened via the LAN address the desktop showed
      // (http://ip:17963/?token=…). The token lives in the URL, so the app
      // can sync the library without the user pasting anything.
      try {
        const urlToken = new URLSearchParams(window.location.search).get("token");
        if (urlToken) {
          const autoUrl = `${window.location.origin}/?token=${encodeURIComponent(urlToken)}`;
          const savedLan = localStorage.getItem("needmusic:lanUrl");
          if (savedLan !== autoUrl) {
            localStorage.setItem("needmusic:lanUrl", autoUrl);
          }
          setLanUrl(autoUrl);
          syncLanLibrary(autoUrl)
            .then((n) => { if (n > 0) setLanStatus(`Connected — ${n} tracks synced from your computer.`); })
            .catch((e) => setLanStatus(`LAN sync failed: ${e}`));
        }
      } catch { /* ignore */ }

      // If this HTTPS page (e.g. GitHub Pages) has a saved LAN URL, the
      // browser blocks streaming from the http:// LAN server (mixed content) —
      // detect it up front so we can offer a jump to the LAN player.
      try {
        const savedLan = localStorage.getItem("needmusic:lanUrl");
        if (savedLan) {
          const lanOrigin = new URL(savedLan).origin;
          setLanMixedContent(window.location.protocol === "https:" && window.location.origin !== lanOrigin);
        }
      } catch { /* ignore */ }

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

  // ── Sync the desktop library over LAN and merge into local tracks ──
  const syncLanLibrary = useCallback(async (url: string) => {
    const res = await fetch(lanApi(url, "/api/library"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

    // Refresh stale LAN URLs: a re-connect (server restart rotates the token)
    // must update existing tracks' audioUrl, otherwise playback fails with
    // "TypeError: Load failed".
    for (const t of remoteTracks) {
      const existing = webTrackStore.getById(t.id);
      if (existing) {
        t.isFavorite = existing.isFavorite; // preserve local heart for now
      }
      webTrackStore.addTrack(t);
    }

    // Pull playlists + favorites from the desktop so the phone sees the same
    // playlists and hearts (best-effort — never blocks the track sync).
    try {
      const plRes = await fetch(lanApi(url, "/api/playlists"));
      if (plRes.ok) {
        const plData = await plRes.json();
        mergeServerPlaylists(plData.playlists ?? []);
        applyFavoriteIds(plData.favorite_track_ids ?? []);
      }
    } catch { /* playlists sync failed — ignore */ }

    // Mixed-content check: an HTTPS page (e.g. GitHub Pages) cannot stream
    // from an http:// LAN server — the browser blocks every fetch, so sync
    // "works" but playback always fails with "Load failed".
    setLanMixedContent(window.location.protocol === "https:" && url.startsWith("http://"));

    // Restore downloaded copies for any newly synced tracks.
    attachDownloadedBlobs(webTrackStore.getAll()).catch(() => {});

    persistTracks(webTrackStore.getAll());
    return remoteTracks.length;
  }, [persistTracks, attachDownloadedBlobs]);

  // ── Filter/Search ─────────────────────────────────
  const filteredTracks = useMemo(() => {
    let list = tracks;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = tracks.filter((t) => {
        switch (filterField) {
          case "Title": return t.title.toLowerCase().includes(q);
          case "Artist": return t.artist.toLowerCase().includes(q);
          case "Album": return t.album.toLowerCase().includes(q);
          case "Genre": return t.genre.toLowerCase().includes(q);
          default: return t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q);
        }
      });
    }
    return sortTracks(list, sortMode);
  }, [tracks, searchQuery, filterField, sortMode]);

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
    setPlayError(null);
    try {
      // Play the local copy when available; otherwise download the track to
      // the phone first (fetch → IndexedDB → blob URL), then play it locally.
      // This avoids LAN streaming quirks entirely — the phone just plays its
      // own downloaded file.
      const url = await downloadTrack(td);
      const playable = { ...toPlayableTrack(td), filePath: url };
      await engine.play(playable as any);
    } catch (e: any) {
      // Media errors are vague ("The operation is not supported" / "Load
      // failed"). Probe the audio URL (1-byte Range) to find the real cause:
      // token expired, file missing, or unsupported codec — and auto-heal
      // the expired-token case by re-syncing and retrying.
      let msg = (e && e.message) || String(e);
      const looksLikeMediaError = /not supported|load failed|fetch|media|decode/i.test(msg);
      if (looksLikeMediaError && lanUrl) {
        try {
          // Probe the EXACT url the element tried (td.audioUrl may hold a
          // stale token from before the desktop app restarted).
          const probeUrl = td.audioUrl || lanApi(lanUrl, `/audio/${encodeURIComponent(td.id)}`);
          const probe = await fetch(probeUrl, { headers: { Range: "bytes=0-0" } });
          if (probe.status === 401) {
            // Token rotated (desktop app restarted) → re-sync refreshes
            // audioUrl, then retry with the fresh track.
            try {
              await syncLanLibrary(lanUrl);
              const fresh = webTrackStore.getById(td.id);
              if (fresh) {
                const freshUrl = await downloadTrack(fresh);
                await engine.play({ ...toPlayableTrack(fresh), filePath: freshUrl } as any);
                setPlayError(null);
                return;
              }
              msg = "connection expired — reconnect and try again.";
            } catch (retryErr: any) {
              msg = `connection expired (the desktop app's security key changed — it does on every restart). In NeedMusic on the computer: Settings → LAN Sync → Stop Server, Start Server, then open the NEW address on this phone. (${(retryErr && retryErr.message) || retryErr})`;
            }
          } else if (probe.status !== 206) {
            msg = `the file isn't available on the computer (HTTP ${probe.status}) — it may have moved or been deleted. Rescan on the desktop and reconnect.`;
          } else {
            const ct = probe.headers.get("content-type") || "";
            const real = downloadedFormatRef.current.get(td.id);
            msg = /^(audio|video)\//.test(ct)
              ? real
                ? `This file is actually ${real} (the .${(td.audioUrl?.split(".").pop() || "?").split("?")[0]} name is misleading) — iPhone Safari can't play ${real.toLowerCase().includes("mp4") || real.toLowerCase().includes("m4a") ? "this MP4-family file as audio" : "this format"} in a browser. Convert it to plain MP3/AAC on the computer, or play the downloaded file in the iPhone Files app.`
                : `this format (${ct}) isn't playing on this device. ` +
                  (ct === "video/mp4" || ct === "audio/mp4"
                    ? "MP4 files (especially video ones) often won't play as audio in iPhone Safari. "
                    : "") +
                  "If the file is fine on the computer, restart the iPhone or try a private tab — iOS Safari has a known audio-loading bug."
              : `the computer returned a non-media response (${ct}) — reconnect and try again.`;
          }
        } catch { /* probe blocked/failed too (e.g. HTTPS page) — keep original message */ }
      }
      const isNetwork = e instanceof TypeError || /fetch|load/i.test(msg);
      setPlayError(
        `Couldn't play "${td.title}": ${msg}` +
          (isNetwork
            ? " — can't reach the computer. Check: desktop app running, same Wi-Fi, and open the app via the LAN address (http://ip:17963/?token=…) — not the GitHub Pages site. On iPhone: Settings → Privacy & Security → Local Network → enable Safari."
            : "")
      );
    }
  }, [engine, lanUrl, syncLanLibrary, downloadTrack]);

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
    // Free the downloaded copy too.
    const url = downloadedRef.current.get(td.id);
    if (url) {
      URL.revokeObjectURL(url);
      downloadedRef.current.delete(td.id);
      removeDownloadedAudio(td.id).catch(() => {});
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
              <select className="filter-select" value={sortMode} onChange={(e) => setSortMode(e.target.value)} title="Sort tracks">
                {SORT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
              <input className="search-input" type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
              {lanUrl && filteredTracks.length > 0 && (
                <button
                  className="online-search-btn"
                  style={{ padding: "6px 10px", fontSize: 12 }}
                  onClick={() => handleDownloadAll(filteredTracks)}
                  disabled={downloadingId !== null}
                  title="Download all tracks to this device"
                >
                  <IconDownload size={13} /> Download all
                </button>
              )}
            </div>
          )}
          <div className="content-area">
            {lanMixedContent && (
              <div className="online-warning" style={{ margin: 8, alignItems: "flex-start" }}>
                <IconAlert size={14} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  This page is served over <strong>HTTPS</strong> (GitHub Pages), so the browser blocks
                  streaming from your computer's <strong>http://</strong> LAN address — playback will fail
                  here no matter what. Open the player directly from your computer instead.
                  {lanUrl && (
                    <button
                      onClick={() => { window.location.href = lanUrl; }}
                      style={{ display: "block", marginTop: 8, background: "#ffc107", color: "#111", border: "none", padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                    >▶ Open LAN Player</button>
                  )}
                </span>
                <button onClick={() => setLanMixedContent(false)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 2 }} title="Dismiss"><IconClose size={12} /></button>
              </div>
            )}
            {playError && (
              <div className="online-error" style={{ margin: 8 }}>
                <IconAlert size={14} />
                <span style={{ flex: 1, minWidth: 0 }}>{playError}</span>
                <button onClick={() => setPlayError(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 2 }} title="Dismiss"><IconClose size={12} /></button>
              </div>
            )}
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
                  setLanStatus(null);
                  try { localStorage.removeItem("needmusic:lanUrl"); } catch { /* ignore */ }
                }}
                syncLibrary={syncLanLibrary}
                autoStatus={lanStatus}
              />
            ) : (
              <TrackListView
                tracks={filteredTracks}
                currentTrack={ct}
                onPlay={handlePlayTrack}
                onToggleFav={handleToggleFavorite}
                onRemove={handleRemoveTrack}
                onDownload={downloadTrack}
                onSave={saveTrackToFiles}
                isDownloaded={isDownloaded}
                downloadingId={downloadingId}
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
  onDownload?: (t: TrackData) => void;
  onSave?: (t: TrackData) => void;
  isDownloaded?: (id: string) => boolean;
  downloadingId?: string | null;
}> = ({ tracks, currentTrack, onPlay, onToggleFav, onRemove, onDownload, onSave, isDownloaded, downloadingId }) => (
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
        {onDownload && (
          <span
            className={`col-dl ${downloadingId === t.id ? "downloading" : ""} ${isDownloaded?.(t.id) ? "downloaded" : ""}`}
            title={isDownloaded?.(t.id) ? "Downloaded to this device" : "Download to this device"}
            onClick={(e) => { e.stopPropagation(); if (downloadingId !== t.id) onDownload(t); }}
          >
            {downloadingId === t.id
              ? <span className="dl-spinner" />
              : isDownloaded?.(t.id) ? <IconCheck size={13} /> : <IconDownload size={13} />}
          </span>
        )}
        {onSave && (
          <span className="col-save" title="Save to Files (find it in the Files app)" onClick={(e) => { e.stopPropagation(); onSave(t); }}>
            <IconFolder size={13} />
          </span>
        )}
      </div>
    ))}
  </div>
);

const WebSettingsView: React.FC<{
  lanUrl: string;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
  syncLibrary: (url: string) => Promise<number>;
  autoStatus?: string | null;
}> = ({ lanUrl, onConnect, onDisconnect, syncLibrary, autoStatus }) => {
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
      const count = await syncLibrary(url);
      onConnect(url);
      setLanStatus(`Connected — ${count} tracks synced from your computer.`);
    } catch (e) {
      setLanStatus(String(e));
    } finally {
      setLanBusy(false);
    }
  };

  return (
    <div className="track-list web-settings" style={{ padding: 24 }}>
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
          On your computer open Settings → LAN Sync → Start Server, then open the address it shows
          on this phone — it contains a security token, e.g. <code style={{ color: "#ccc" }}>http://192.168.1.10:17963/?token=…</code>.
          The player loads directly from your computer (no separate web server needed).
          Your phone and computer must be on the same Wi-Fi.
        </p>
        <div className="lan-connect-row" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
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
        {autoStatus && !lanStatus && <p style={{ fontSize: 11, color: autoStatus.startsWith("Connected") ? "#4ecdc4" : "#e94560", marginBottom: 8 }}>{autoStatus}</p>}
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
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);

  const search = async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    setResults([]);
    setSourceErrors([]);
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
      // Per-source failures are non-fatal: surface them so the user knows why
      // a source is missing (e.g. Bilibili blocking the request or YouTube
      // being disabled — both are proxied through the desktop, not the phone).
      const errs: string[] = [];
      if (data.bilibili_error) errs.push(`Bilibili: ${data.bilibili_error}`);
      if (data.youtube_error) errs.push(`YouTube: ${data.youtube_error}`);
      setSourceErrors(errs);
      if (merged.length === 0 && errs.length === 0) setError("No results found. Try a different search term.");
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
      {sourceErrors.length > 0 && (
        <div className="online-warning" style={{ marginTop: 8 }}>
          <IconAlert size={14} />
          <span>
            Some sources are unavailable (search runs on your computer, not the phone):
            {sourceErrors.map((e, i) => <span key={i} style={{ display: "block", fontSize: 11, opacity: 0.9 }}>• {e}</span>)}
          </span>
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

/**
 * Merge playlists received from the desktop LAN server into the local store.
 * Desktop playlists win on id collisions; mobile-only playlists are kept.
 */
function mergeServerPlaylists(server: { id: string; name: string; track_ids?: string[] }[]): void {
  const local = loadPlaylists();
  const byId = new Map(local.map((p) => [p.id, p]));
  for (const sp of server) {
    byId.set(sp.id, { id: sp.id, name: sp.name, trackIds: sp.track_ids ?? [] });
  }
  savePlaylists([...byId.values()]);
}

/** Mark tracks as favorites based on the desktop's favorite ids. */
function applyFavoriteIds(ids: string[]): void {
  const set = new Set(ids);
  // getAll() returns the same object references, so mutating updates the store;
  // persistTracks() in syncLanLibrary then saves the flags to localStorage.
  for (const t of webTrackStore.getAll()) {
    t.isFavorite = set.has(t.id);
  }
}

const WebPlaylistsView: React.FC<{ tracks: TrackData[]; onPlay: (t: TrackData) => void }> = ({ tracks, onPlay }) => {
  const [playlists, setPlaylists] = useState<WebPlaylist[]>(loadPlaylists);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragTrack, setDragTrack] = useState<string | null>(null);

  // Re-read playlists after a LAN sync merges the desktop's playlists in.
  useEffect(() => { setPlaylists(loadPlaylists()); }, [tracks]);

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
    <div className="web-playlists" style={{ display: "flex", height: "100%" }}>
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
/* ── Download button on track rows ── */
.col-dl {
  width: 28px;
  text-align: center;
  color: var(--text-tertiary, #888);
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.col-dl:hover { color: var(--accent-primary, #e94560); }
.col-dl.downloaded { color: #4ecdc4; }
.col-dl.downloading { color: var(--accent-primary, #e94560); }
.col-save {
  width: 28px;
  text-align: center;
  color: var(--text-tertiary, #888);
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.col-save:hover { color: var(--accent-primary, #e94560); }
.dl-spinner {
  width: 12px; height: 12px;
  border: 2px solid rgba(255,255,255,.2);
  border-top-color: var(--accent-primary, #e94560);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}

/* ── Mobile layout (≤768px): horizontal top nav + compact pinned player ── */
@media (max-width: 768px) {
  html, body { overflow: hidden; }
  .app-wrapper { height: 100dvh; }

  /* Desktop-only right panel takes too much room on a phone */
  .queue-panel { display: none !important; }

  .app-layout { flex-direction: column !important; }

  /* Nav becomes a top bar */
  .icon-sidebar {
    flex-direction: row !important;
    width: 100% !important;
    min-width: 0 !important;
    height: auto !important;
    padding: 6px 8px !important;
    gap: 2px !important;
    justify-content: flex-start !important;
    border-right: none !important;
    border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.08)) !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  .icon-nav-item { width: 44px !important; height: 44px !important; flex-shrink: 0 !important; }
  .icon-nav-spacer { display: none !important; }

  .main-area { width: 100% !important; flex: 1 !important; min-height: 0 !important; }
  .content-area { flex: 1 !important; min-height: 0 !important; }

  /* Search bar: stack filter + input without overflowing */
  .content-search-bar { flex-wrap: wrap !important; gap: 6px !important; padding: 6px 10px !important; }
  .content-search-bar .search-input { width: 100% !important; }
  .filter-select { padding: 6px 8px !important; font-size: 13px !important; }

  /* Compact two-row player bar pinned to the bottom */
  .player-bar {
    flex-direction: row !important;
    flex-wrap: wrap !important;
    align-items: center !important;
    gap: 2px 10px !important;
    padding: 6px 12px !important;
    padding-bottom: calc(6px + env(safe-area-inset-bottom)) !important;
    min-height: 0 !important;
  }
  .player-left { order: 1 !important; flex: 1 !important; width: auto !important; min-width: 0 !important; gap: 10px !important; }
  .player-artwork { width: 40px !important; height: 40px !important; font-size: 16px !important; }
  .player-center { order: 3 !important; width: 100% !important; flex-direction: column !important; gap: 2px !important; }
  .player-controls { justify-content: center !important; gap: 6px !important; }
  .player-right { order: 2 !important; width: auto !important; flex: 0 0 auto !important; }
  .volume-slider, .speed-select, .player-right .ctrl-btn { display: none !important; }
  .player-track-details { max-width: 100% !important; }
  .player-title { font-size: 13px !important; }
  .player-artist { font-size: 11px !important; }

  /* Track list: roomier rows, hide desktop columns */
  .track-list-header { font-size: 11px !important; padding: 8px 10px !important; }
  .track-row { font-size: 13px !important; padding: 10px 8px !important; margin: 2px 6px !important; min-height: 48px !important; }
  .col-album, .col-artist { display: none !important; }
  .col-dur { width: 44px !important; font-size: 12px !important; }
  .col-fav { width: 40px !important; }
  .col-add, .col-remove, .col-dl, .col-save { width: 36px !important; opacity: 1 !important; font-size: 16px !important; }
  .track-empty { padding: 40px 20px !important; font-size: 14px !important; }

  /* Online search: full-width input, comfy rows */
  .online-search-view { padding: 12px !important; }
  .online-search-bar { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
  .online-search-input { font-size: 16px !important; padding: 10px 14px !important; }
  .online-search-btn { padding: 10px 14px !important; font-size: 15px !important; }
  .online-result-row { padding: 10px 12px !important; }
  .online-result-row-actions .online-action-btn { padding: 8px 12px !important; font-size: 12px !important; }
  .online-error, .online-warning { font-size: 13px !important; padding: 10px 12px !important; align-items: flex-start !important; }
  .online-warning span { min-width: 0 !important; }

  /* Playlists: stack the two panes vertically */
  .web-playlists { flex-direction: column !important; }
  .web-playlists > div:first-child {
    width: 100% !important;
    border-right: none !important;
    border-bottom: 1px solid #222 !important;
    max-height: 34vh !important;
    flex: 0 0 auto !important;
  }
  .web-playlists > div:first-child input { font-size: 16px !important; padding: 8px 10px !important; }
  .web-playlists > div:last-child { flex: 1 !important; min-height: 0 !important; }

  /* Settings: readable on a phone */
  .web-settings { padding: 14px !important; }
  .web-settings input { font-size: 16px !important; }
  .lan-connect-row { flex-wrap: wrap !important; }
  .lan-connect-row input { min-width: 100% !important; }
  .settings-row { flex-wrap: wrap !important; gap: 8px !important; }
  .settings-row input[type="range"] { flex: 1 !important; min-width: 140px !important; }
  .settings-input.short { width: 100% !important; }
}

@media (max-width: 480px) {
  .player-left .ctrl-btn { display: none !important; }
  .ctrl-btn { padding: 8px !important; }
  .play-btn { width: 44px !important; height: 44px !important; }
}
`;

if (typeof document !== "undefined") {
  const styleEl = document.createElement("style");
  styleEl.textContent = mobileStyles;
  document.head.appendChild(styleEl);
}

export default WebApp;
