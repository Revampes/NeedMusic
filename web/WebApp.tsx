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
  saveDownloadedAudio, getDownloadedAudio, removeDownloadedAudio, getAllDownloadedAudio,
} from "./downloads";
import { buildZip } from "./zip";
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

/** Start chunk size for downloads. Halved automatically when a chunk fails,
 *  because iOS-over-LAN tolerates small transfers but can kill larger ones
 *  (a 512 KB chunk failed on the user's phone while 1-byte probes worked). */
const DL_CHUNK = 512 * 1024;
/** Never shrink below this: tiny chunks still fail fast and are not the fix. */
const DL_MIN_CHUNK = 4096;

/**
 * Download a complete file as a Blob using ONLY patterns proven to work on
 * iOS Safari over plain HTTP:
 *  - bodies are read with response.arrayBuffer(), NEVER response.blob()
 *    (iOS Safari's blob() is unreliable over HTTP while arrayBuffer works —
 *    that is exactly why the format sniff succeeds but downloads failed);
 *  - the file is fetched in short Range chunks that SHRINK on failure (if the
 *    network kills a 512 KB transfer, it halves until a size succeeds, down
 *    to 4 KB) — every download resumes where it left off;
 *  - the final blob size is verified against the server-declared total.
 */
async function fetchFullFile(url: string): Promise<Blob> {
  // 1) Probe: learn the total size from a 1-byte Range request.
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
  let total = -1;
  if (probe.status === 206) {
    const m = (probe.headers.get("content-range") || "").match(/\/(\d+)$/);
    if (m) total = Number(m[1]);
  } else if (probe.ok) {
    // Server ignored the range header — it returned the whole file.
    const buf = await probe.arrayBuffer();
    if (buf.byteLength > 0) return new Blob([buf], { type: "audio/mpeg" });
  } else {
    throw new Error(`HTTP ${probe.status}`);
  }
  if (total <= 0) throw new Error("could not determine file size");

  // 2) Chunked download, stitched into one Blob.
  const parts: Blob[] = [];
  let start = 0;
  let size = DL_CHUNK;
  const failures: string[] = [];
  while (start < total) {
    const end = Math.min(start + size - 1, total - 1);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("empty chunk");
      parts.push(new Blob([buf]));
      start = end + 1;
    } catch (e: any) {
      failures.push(`@${start}:${(e && e.message) || e}`);
      if (size > DL_MIN_CHUNK) {
        // Halve the chunk size and retry the SAME range — iOS/LAN networks
        // accept smaller transfers when larger ones get killed.
        size = Math.floor(size / 2);
      } else {
        throw new Error(`download failed at byte ${start} (${failures.slice(-3).join("; ")})`);
      }
    }
  }
  const blob = new Blob(parts, { type: "audio/mpeg" });
  // Integrity check: a truncated download must not be played or saved.
  if (blob.size !== total) {
    throw new Error(`incomplete download: got ${blob.size} of ${total} bytes`);
  }
  return blob;
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

/**
 * The audio URL that should be PLAYED right now for a track:
 * - Local copies (blob:/data: from downloads or imports) are used unchanged,
 *   so they play offline.
 * - Remote LAN URLs are rebuilt against the CURRENT server address + token
 *   (the token in a saved URL goes dead when the desktop restarts), which
 *   is the #1 cause of "I can see the tracks but playback fails".
 */
function playableAudioUrl(td: TrackData, lanUrl: string): string {
  if (!td.audioUrl) return "";
  if (td.audioUrl.startsWith("blob:") || td.audioUrl.startsWith("data:")) return td.audioUrl;
  try {
    const u = new URL(td.audioUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return td.audioUrl;
    if (!lanUrl) return td.audioUrl; // no server known — let play() fail loudly
    // Strip the old token, keep the rest of the path/query, re-point at the
    // current server with the current token.
    const q = u.search.replace(/[?&]token=[^&]*/, "");
    const pathAndQuery = u.pathname + (q ? (q.startsWith("?") ? q : `?${q}`) : "");
    return lanApi(lanUrl, pathAndQuery);
  } catch {
    return td.audioUrl;
  }
}

/**
 * Append a hint that makes HtmlAudioPlayer use its <video> element for
 * MP4-family sources whose real format is hidden (LAN /audio/{id} and blob:
 * URLs don't end in .mp4). iOS Safari won't play some MP4 containers through
 * <audio>, but handles them fine through a hidden <video>.
 */
function withMp4Hint(url: string, isMp4Family: boolean): string {
  if (!isMp4Family || !url || url.includes("__mp4=1")) return url;
  return url + (url.includes("?") ? "&" : "?") + "__mp4=1";
}

/**
 * True when a track is (or is likely) an MP4-family file (mp4/m4a/m4b).
 * `knownFormats` is the {trackId → sniffed format} map (may be empty).
 */
function isMp4FamilyTrack(td: TrackData, knownFormats: ReadonlyMap<string, string>): boolean {
  const c = (td.codec || "").toLowerCase();
  if (c === "mp4" || c === "m4a" || c === "m4b") return true;
  const real = knownFormats.get(td.id) || "";
  return /mp4|m4a|m4b/i.test(real);
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
  // Fatal connection problem (stale token / unreachable server) — shown as a
  // prominent banner with a reconnect action instead of silent failures.
  const [connError, setConnError] = useState<string | null>(null);
  // True when this page is HTTPS but the LAN server is HTTP — browsers block
  // streaming from an insecure LAN address on a secure page (mixed content).
  const [lanMixedContent, setLanMixedContent] = useState(false);
  // Track id → local blob URL of a downloaded copy (plays without LAN).
  const downloadedRef = useRef(new Map<string, string>());
  // Track id → detected real format (from the file's magic bytes).
  const downloadedFormatRef = useRef(new Map<string, string>());
  // Track id currently being downloaded (for UI feedback).
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Bumped whenever a downloaded copy is added/removed so status indicators
  // (badges, summary counts) re-render — the blob map itself is a ref.
  const [dlVersion, setDlVersion] = useState(0);
  // Track shown in the ⋯ action sheet (mobile).
  const [menuTrack, setMenuTrack] = useState<TrackData | null>(null);
  // Spotify-style expanded now-playing sheet.
  const [nowPlaying, setNowPlaying] = useState(false);

  /** Queue/favorites use the SAVED copy on this device (download-first). */
  const queuePanelTracks = useMemo(() =>
    tracks.map((t) => ({
      ...toPlayableTrack(t),
      filePath: downloadedRef.current.get(t.id) || t.audioUrl,
    })) as any,
  [tracks, dlVersion]);

  /** True when a track is playable on this device right now: either it was
   *  downloaded to IndexedDB, or it's a locally imported file (blob/data URL).
   */
  const isTrackLocal = useCallback((t: TrackData) =>
    downloadedRef.current.has(t.id) ||
    !!t.audioUrl && (t.audioUrl.startsWith("blob:") || t.audioUrl.startsWith("data:")),
  []);

  const isDownloaded = useCallback((id: string) => {
    const t = webTrackStore.getById(id);
    return t ? isTrackLocal(t) : false;
  }, [isTrackLocal]);

  /** Attach blob URLs from IndexedDB to tracks that were downloaded before. */
  const attachDownloadedBlobs = useCallback(async (list: TrackData[]) => {
    let attached = 0;
    for (const td of list) {
      if (downloadedRef.current.has(td.id)) continue;
      try {
        const blob = await getDownloadedAudio(td.id);
        if (blob) {
          downloadedRef.current.set(td.id, URL.createObjectURL(blob));
          attached++;
        }
      } catch { /* not downloaded / storage unavailable */ }
    }
    if (attached > 0) setDlVersion((v) => v + 1);
  }, []);

  /** Download a track to the phone (fetch → IndexedDB → local blob URL). */
  const downloadTrack = useCallback(async (td: TrackData): Promise<string> => {
    const cached = downloadedRef.current.get(td.id);
    if (cached) return cached;
    // Always fetch from the CURRENT server address/token (a saved URL may
    // hold a dead token after the desktop restarted).
    const src = playableAudioUrl(td, lanUrl);
    if (!src) {
      throw new Error(
        lanUrl
          ? "this track has no source on the computer — rescan your library and reconnect."
          : "not connected to your computer — connect in Settings first."
      );
    }
    setDownloadingId(td.id);
    try {
      // Chunked Range download — iOS Safari can't fetch whole audio files
      // over HTTP, but handles many small range requests without issue.
      const blob = await fetchFullFile(src);
      // Sniff the REAL format from the file's magic bytes — the extension can
      // lie (e.g. an MP4 container named .mp3), which is why iOS refuses it.
      try {
        const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
        downloadedFormatRef.current.set(td.id, sniffFormat(head));
      } catch { /* ignore */ }
      const url = URL.createObjectURL(blob);
      downloadedRef.current.set(td.id, url);
      setDlVersion((v) => v + 1);
      try { await saveDownloadedAudio(td.id, blob); } catch { /* storage full — playable this session only */ }
      return url;
    } finally {
      setDownloadingId(null);
    }
  }, [lanUrl]);

  /** Download a single track, surfacing failures instead of swallowing them. */
  const handleDownloadTrack = useCallback(async (td: TrackData) => {
    try {
      await downloadTrack(td);
    } catch (e: any) {
      setPlayError(
        `Couldn't save "${td.title}" on this device: ${(e && e.message) || e}. ` +
          (lanUrl
            ? "It isn't on this device yet — check that the computer is running and you're on the same Wi-Fi, then try again."
            : "Connect to your computer first (Settings → Sync with Computer).")
      );
    }
  }, [downloadTrack, lanUrl]);

  /** Download every track in the given list to the phone. */
  const handleDownloadAll = useCallback(async (list: TrackData[]) => {
    const pending = list.filter((td) => !downloadedRef.current.has(td.id) && playableAudioUrl(td, lanUrl));
    let ok = 0;
    let fail = 0;
    let firstErr = "";
    for (const td of pending) {
      try { await downloadTrack(td); ok++; }
      catch (e: any) {
        fail++;
        if (!firstErr) firstErr = (e && e.message) || String(e);
      }
    }
    if (pending.length === 0) return;
    if (fail > 0) {
      setPlayError(`Saved ${ok} of ${pending.length} tracks on this device (${fail} failed: ${firstErr}).`);
    }
  }, [downloadTrack, lanUrl]);

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

  /**
   * Save EVERY downloaded track to the Files app as one ZIP archive (iOS
   * won't allow silent bulk saves — each file normally needs its own tap and
   * share sheet — so a single archive means one tap for the whole library).
   * The Files app unzips natively.
   */
  const saveAllToFiles = useCallback(async () => {
    try {
      const downloads = await getAllDownloadedAudio();
      if (downloads.length === 0) {
        setPlayError("Nothing to save yet — download some tracks to this device first.");
        return;
      }
      const files = downloads.map(({ id, blob }, i) => {
        const td = webTrackStore.getById(id);
        const ext = formatToExt(downloadedFormatRef.current.get(id) || "");
        const base = (td?.title || "track").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
        return { name: `${String(i + 1).padStart(2, "0")} - ${base}${ext}`, data: blob };
      });
      const zip = await buildZip(files);
      const url = URL.createObjectURL(zip);
      const a = document.createElement("a");
      a.href = url;
      a.download = "NeedMusic-tracks.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setPlayError(null);
    } catch (e: any) {
      setPlayError(`Couldn't create the archive: ${(e && e.message) || e}`);
    }
  }, []);

  // ── Initialize ────────────────────────────────────
  useEffect(() => {
    try {
      initWebPlayer();
      // Restore settings from localStorage.
      const savedVol = localStorage.getItem("needmusic:volume");
      if (savedVol) engine.setVolume(Number(savedVol));
      const savedRate = localStorage.getItem("needmusic:playbackRate");
      if (savedRate) engine.setPlaybackRate(Number(savedRate));
      // ── Revamp storage migration ──
      // Older builds saved tracks with dead LAN URLs and stale tokens, which
      // left the phone in a permanently-broken state. Bump the storage version
      // once so those stale tracks/playlists are dropped and the app starts
      // clean (re-synced from the computer on connect). Downloaded copies in
      // IndexedDB are KEPT — they are keyed by stable track ids and re-attach
      // after the next sync.
      try {
        if (localStorage.getItem("needmusic:storageVersion") !== "3") {
          localStorage.removeItem("needmusic:tracks");
          localStorage.removeItem("needmusic:playlists");
          localStorage.setItem("needmusic:storageVersion", "3");
        }
      } catch { /* ignore */ }

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

      // Auto-connect: prefer the token in the URL (opening the LAN address the
      // desktop shows), otherwise probe the saved address. A 401 means the
      // desktop restarted and rotated its token — surface that clearly instead
      // of leaving dead tracks behind.
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
        } else {
          const savedLan = localStorage.getItem("needmusic:lanUrl");
          if (savedLan) {
            // Probe before trusting the saved address (it may hold a dead token).
            fetch(lanApi(savedLan, "/api/library"))
              .then((res) => {
                if (res.status === 401) {
                  setConnError("Connection expired — the desktop app's security key changed when it restarted. Reconnect with the current address from the computer (Settings → LAN Sync).");
                  localStorage.removeItem("needmusic:lanUrl");
                  setLanUrl("");
                } else if (res.ok) {
                  setLanUrl(savedLan);
                  return syncLanLibrary(savedLan).then((n) => {
                    if (n > 0) setLanStatus(`Connected — ${n} tracks synced from your computer.`);
                  });
                } else {
                  setConnError(`The computer answered HTTP ${res.status}. Make sure the desktop app is running and you're on the same Wi-Fi.`);
                }
              })
              .catch(() => { /* offline — stay quiet; tracks (if any) still show */ });
          }
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
      codec: t.codec || "mp3",
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

  // ── Track availability (for status badges + summary) ──
  // Every track falls into exactly one bucket: saved on this device,
  // saved on this device, or not downloaded yet. `dlVersion` forces a
  // recompute when a download is added/removed.
  const trackCounts = useMemo(() => {
    let onDevice = 0, pending = 0;
    for (const t of tracks) {
      if (isTrackLocal(t)) onDevice++;
      else pending++;
    }
    return { onDevice, pending };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, dlVersion, isTrackLocal]);

  /** Add a track to the queue — download-first, so queued playback is local. */
  const handleEnqueue = useCallback(async (td: TrackData) => {
    if (!downloadedRef.current.has(td.id)) {
      try {
        await downloadTrack(td);
      } catch (e: any) {
        setPlayError(`Couldn't add "${td.title}" to the queue: download it to this device first — ${(e && e.message) || e}`);
        return;
      }
    }
    const local = downloadedRef.current.get(td.id);
    if (!local) return;
    PlaybackEngine.getInstance().enqueue({ ...toPlayableTrack(td), filePath: local } as any);
  }, [downloadTrack]);

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
      // Persist the imported file to device storage so it survives closing
      // the app (blob URLs die on reload). Best-effort: if storage is full
      // the track still plays this session.
      saveDownloadedAudio(id, file).catch(() => { /* storage full — session only */ });
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
  // Playback is LOCAL-FIRST: imported files (blob/data URLs) play directly;
  // LAN-synced tracks are downloaded to this device, then the local copy
  // plays. Streaming was removed because iOS Safari refuses to render media
  // from a plain http:// LAN address even though downloads work fine.
  const handlePlayTrack = useCallback(async (td: TrackData) => {
    setPlayError(null);

    // 0) A saved copy (downloaded OR persisted import) plays first — it
    //    survives reloads and never touches the network.
    const saved = downloadedRef.current.get(td.id);
    if (saved) {
      try {
        const isMp4 = isMp4FamilyTrack(td, downloadedFormatRef.current);
        await engine.play({ ...toPlayableTrack(td), filePath: withMp4Hint(saved, isMp4) } as any);
      } catch (e: any) {
        setPlayError(`Couldn't play "${td.title}": ${(e && e.message) || e}. The saved copy may be damaged — remove and import/download it again.`);
      }
      return;
    }

    // 1) Locally imported files are ALREADY on this device — play them right
    //    away (no download, no computer needed).
    if (td.audioUrl.startsWith("blob:") || td.audioUrl.startsWith("data:")) {
      try {
        const isMp4 = isMp4FamilyTrack(td, downloadedFormatRef.current);
        await engine.play({ ...toPlayableTrack(td), filePath: withMp4Hint(td.audioUrl, isMp4) } as any);
      } catch (e: any) {
        setPlayError(`Couldn't play "${td.title}": ${(e && e.message) || e}. Try importing the file again.`);
      }
      return;
    }

    // 1) LAN-synced track: ensure it is saved on this device (download it).
    if (!downloadedRef.current.has(td.id)) {
      try {
        await downloadTrack(td);
      } catch (e: any) {
        setPlayError(
          `Couldn't play "${td.title}": download it to this device first — ${(e && e.message) || e}. ` +
            (lanUrl
              ? "Check that the computer is running and you're on the same Wi-Fi, then tap play again."
              : "Connect to your computer first (Settings → Sync with Computer).")
        );
        return;
      }
    }

    // 2) Play the saved local copy. MP4-family files go through the hidden
    //    <video> element (iOS refuses them as <audio>).
    const localUrl = downloadedRef.current.get(td.id);
    if (!localUrl) {
      setPlayError(`Couldn't play "${td.title}": the saved copy is missing — download it again.`);
      return;
    }
    try {
      const isMp4 = isMp4FamilyTrack(td, downloadedFormatRef.current);
      await engine.play({ ...toPlayableTrack(td), filePath: withMp4Hint(localUrl, isMp4) } as any);
    } catch (e: any) {
      setPlayError(
        `Couldn't play "${td.title}": ${(e && e.message) || e}. ` +
          "The saved copy may be incomplete — delete the track and download it again."
      );
    }
  }, [engine, lanUrl, downloadTrack]);

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
      downloadedFormatRef.current.delete(td.id);
      setDlVersion((v) => v + 1);
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

  // Connection chip state: what the user should know at a glance.
  const lanChip = connError
    ? { cls: "error", text: "Reconnect needed" }
    : lanUrl
      ? (lanStatus?.startsWith("Connected")
        ? { cls: "connected", text: "Computer connected" }
        : lanStatus?.startsWith("LAN sync failed")
          ? { cls: "error", text: "Sync failed — reconnect" }
          : { cls: "connecting", text: "Connecting…" })
      : { cls: "offline", text: "Offline" };

  return (
    <div className="app-wrapper">
      <div className="custom-bg-layer" />
      <canvas ref={bgCanvasRef} className="bg-canvas" />
      <div className="app-layout">
        <nav className="icon-sidebar">
          <div className={`icon-nav-item ${activeTab === "Tracks" ? "active" : ""}`} onClick={() => setActiveTab("Tracks")} title="Tracks"><IconLibrary size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Playlists" ? "active" : ""}`} onClick={() => setActiveTab("Playlists")} title="Playlists"><IconPlaylist size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Queue" ? "active" : ""}`} onClick={() => setActiveTab(activeTab === "Queue" ? "Tracks" : "Queue")} title="Queue & Favorites"><IconClock size={18} /></div>
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
              <button
                className={`lan-chip ${lanChip.cls}`}
                onClick={() => setActiveTab("Settings")}
                title="Connection to your computer — tap for Settings"
              >
                <span className="lan-dot" /> {lanChip.text}
              </button>
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
              {trackCounts.onDevice > 0 && (
                <button
                  className="online-search-btn"
                  style={{ padding: "6px 10px", fontSize: 12, background: "#1e2a24", borderColor: "#4ecdc455" }}
                  onClick={saveAllToFiles}
                  title="Save every downloaded track to the Files app as one ZIP"
                >
                  <IconFolder size={13} /> Save all (.zip)
                </button>
              )}
            </div>
          )}
          <div className="content-area">
            {connError && (
              <div className="online-error" style={{ margin: 8, alignItems: "flex-start" }}>
                <IconAlert size={14} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>Not connected.</strong> {connError}
                </span>
                <button
                  onClick={() => { setConnError(null); setActiveTab("Settings"); }}
                  style={{ background: "#e94560", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                >Reconnect</button>
              </div>
            )}
            {lanMixedContent && (
              <div className="online-warning" style={{ margin: 8, alignItems: "flex-start" }}>
                <IconAlert size={14} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  This page is served over <strong>HTTPS</strong> (GitHub Pages), so the browser blocks
                  connecting to your computer's <strong>http://</strong> LAN address — syncing and
                  downloads will fail here no matter what. Open the player directly from your computer instead.
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
            ) : activeTab === "Queue" ? (
              <div className="queue-tab">
                <QueuePanel libraryTracks={queuePanelTracks} />
              </div>
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
              <>
                {tracks.length > 0 && (
                  <div className="track-summary">
                    <span className="ts-label">Library:</span>
                    {trackCounts.onDevice > 0 && <span className="ts-on-device">✓ {trackCounts.onDevice} saved on this device</span>}
                    {trackCounts.pending > 0 && <span className="ts-pending">⬇ {trackCounts.pending} to download (tap ▶ to download & play)</span>}
                  </div>
                )}
                <TrackListView
                  tracks={filteredTracks}
                  currentTrack={ct}
                  onPlay={handlePlayTrack}
                  onToggleFav={handleToggleFavorite}
                  onRemove={handleRemoveTrack}
                  onEnqueue={handleEnqueue}
                  onDownload={handleDownloadTrack}
                  onSave={saveTrackToFiles}
                  onMenu={setMenuTrack}
                  isDownloaded={isDownloaded}
                  downloadingId={downloadingId}
                  lanUrl={lanUrl}
                />
              </>
            )}
          </div>
        </div>
        <QueuePanel libraryTracks={queuePanelTracks} queueVersion={0} />
      </div>
      {/* ── Track ⋯ action sheet (mobile) ── */}
      {menuTrack && (
        <TrackActionSheet
          track={menuTrack}
          isLocal={isTrackLocal(menuTrack)}
          downloading={downloadingId === menuTrack.id}
          onClose={() => setMenuTrack(null)}
          onPlay={() => { const t = menuTrack; setMenuTrack(null); handlePlayTrack(t); }}
          onEnqueue={() => { const t = menuTrack; setMenuTrack(null); handleEnqueue(t); }}
          onDownload={() => { const t = menuTrack; setMenuTrack(null); handleDownloadTrack(t); }}
          onSave={() => { const t = menuTrack; setMenuTrack(null); saveTrackToFiles(t); }}
          onRemove={() => { const t = menuTrack; setMenuTrack(null); handleRemoveTrack(t); }}
          onToggleFav={() => { const t = menuTrack; setMenuTrack(null); handleToggleFavorite(t); }}
        />
      )}
      {/* Player Bar */}
      <div
        className="player-bar frosted-panel"
        onClick={() => { if (window.innerWidth <= 1024) setNowPlaying(true); }}
      >
        <div className="player-left">
          <div className="player-artwork">{ct && (ct as any).hasArtwork ? <IconImage size={20} /> : <IconMusic size={20} />}</div>
          {ct ? (
            <div className="player-track-details">
              <MarqueeText className="player-title" active>{ct.title}</MarqueeText>
              <MarqueeText className="player-artist">{ct.displayArtist()}</MarqueeText>
            </div>
          ) : (
            <div className="player-track-details">
              <div className="player-title" style={{ color: "#555" }}>No track playing</div>
              <div className="player-artist" style={{ color: "#444" }}>Select a track — or import files</div>
            </div>
          )}
        </div>
        <button
          className="player-bar-play ctrl-btn play-btn"
          onClick={(e) => { e.stopPropagation(); isPlaying ? engine.pause() : engine.resume(); }}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
        </button>
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
      {/* ── Now-playing sheet (mobile, Spotify-style) ── */}
      {nowPlaying && (
        <NowPlayingSheet
          currentTrack={ct}
          isPlaying={isPlaying}
          player={player}
          onClose={() => setNowPlaying(false)}
          onToggleFav={() => ct && handleToggleFavorite(tracks.find((t) => (ct as any).id === t.id)!)}
          onToggleShuffle={() => setPlayer((p) => ({ ...p, isShuffled: !p.isShuffled }))}
          onCycleRepeat={() => {
            const modes = [RepeatMode.Off, RepeatMode.Playlist, RepeatMode.Track];
            engine.repeatMode = modes[(modes.indexOf(player.repeatMode) + 1) % 3];
            setPlayer((p) => ({ ...p, repeatMode: engine.repeatMode }));
          }}
          onSetVolume={(v) => {
            engine.setVolume(v);
            setPlayer((p) => ({ ...p, volume: v }));
            localStorage.setItem("needmusic:volume", String(v));
          }}
          onSetRate={(r) => {
            engine.setPlaybackRate(r);
            setPlayer((p) => ({ ...p, playbackRate: r }));
          }}
        />
      )}
    </div>
  );
};

// ─── Sub-Views ──────────────────────────────────────

/** Spotify-style expanded player: big artwork, sliding title, progress,
 *  and the full control set (shuffle / prev / play / next / repeat) plus
 *  volume and speed — where phones can reach everything. */
const NowPlayingSheet: React.FC<{
  currentTrack: ITrack | null;
  isPlaying: boolean;
  player: PlayerState;
  onClose: () => void;
  onToggleFav: () => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onSetVolume: (v: number) => void;
  onSetRate: (r: number) => void;
}> = ({ currentTrack: ct, isPlaying, player, onClose, onToggleFav, onToggleShuffle, onCycleRepeat, onSetVolume, onSetRate }) => {
  const engine = PlaybackEngine.getInstance();
  return (
    <div className="np-backdrop" onClick={onClose}>
      <div className="now-playing-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="np-grabber" />
        <button className="np-close" onClick={onClose} title="Close"><IconClose size={18} /></button>
        <div className="np-artwork">
          {ct ? (ct as any).hasArtwork ? <IconImage size={44} /> : <IconMusic size={44} /> : <IconMusic size={44} />}
        </div>
        <div className="np-text">
          <MarqueeText className="np-title" active>{ct ? ct.title : "No track playing"}</MarqueeText>
          <div className="np-artist">{ct ? ct.displayArtist() : "Select a track to start"}</div>
        </div>
        <div className="np-progress">
          <ProgressBar currentSecs={player.currentTimeSecs} totalSecs={player.durationSecs} onSeek={(s) => engine.seek(s)} />
          <div className="np-times">
            <span>{formatDuration(player.currentTimeSecs)}</span>
            <span>{formatDuration(player.durationSecs)}</span>
          </div>
        </div>
        <div className="np-controls">
          <button className={`ctrl-btn ${player.isShuffled ? "active" : ""}`} onClick={onToggleShuffle} title="Shuffle"><IconShuffle size={20} /></button>
          <button className="ctrl-btn" onClick={() => engine.previous()} title="Previous"><IconPrevious size={24} /></button>
          <button className="ctrl-btn np-play" onClick={() => isPlaying ? engine.pause() : engine.resume()} title={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <IconPause size={28} /> : <IconPlay size={28} />}
          </button>
          <button className="ctrl-btn" onClick={() => engine.next()} title="Next"><IconNext size={24} /></button>
          <button className={`ctrl-btn ${player.repeatMode !== RepeatMode.Off ? "active" : ""}`}
            title={`Repeat: ${player.repeatMode === RepeatMode.Track ? "Track" : player.repeatMode === RepeatMode.Playlist ? "Playlist" : "Off"}`}
            onClick={onCycleRepeat}>
            {player.repeatMode === RepeatMode.Track ? <IconRepeatOne size={20} /> : player.repeatMode === RepeatMode.Playlist ? <IconRepeat size={20} /> : <IconRepeatOff size={20} />}
          </button>
        </div>
        <div className="np-extra">
          <button className={`ctrl-btn ${player.isFavorite ? "active" : ""}`} onClick={onToggleFav} title={player.isFavorite ? "Unfavorite" : "Favorite"}>
            {player.isFavorite ? <IconHeartFill size={20} /> : <IconHeart size={20} />}
          </button>
          <select className="speed-select" value={player.playbackRate} onChange={(e) => onSetRate(Number(e.target.value))} title={`Speed: ${player.playbackRate}x`}>
            {SPEED_OPTIONS.map((s) => (<option key={s} value={s}>{s}x</option>))}
          </select>
          <div className="np-volume">
            <IconVolume size={16} />
            <input type="range" min="0" max="100" value={Math.round(player.volume * 100)}
              onChange={(e) => onSetVolume(Number(e.target.value) / 100)} title={`Volume: ${Math.round(player.volume * 100)}%`} />
          </div>
        </div>
      </div>
    </div>
  );
};

/** Bottom action sheet for a track's "⋯" menu (mobile). */
const TrackActionSheet: React.FC<{
  track: TrackData;
  isLocal: boolean;
  downloading: boolean;
  onClose: () => void;
  onPlay: () => void;
  onEnqueue: () => void;
  onDownload: () => void;
  onSave: () => void;
  onRemove: () => void;
  onToggleFav: () => void;
}> = ({ track: t, isLocal, downloading, onClose, onPlay, onEnqueue, onDownload, onSave, onRemove, onToggleFav }) => {
  const item = (icon: React.ReactNode, label: string, onClick: () => void, danger?: boolean) => (
    <button
      className={`action-sheet-item ${danger ? "danger" : ""}`}
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", background: "none", border: "none", color: danger ? "#e94560" : "#e0e0e0", padding: "16px 20px", fontSize: 16, cursor: "pointer", textAlign: "left" }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <div className="action-sheet-backdrop" onClick={onClose}>
      <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="action-sheet-grabber" />
        <div className="action-sheet-track">
          <div className="action-sheet-title">{t.title}</div>
          <div className="action-sheet-meta">
            {t.artist} · {t.album} · {formatDuration(t.durationSecs)}
            {isLocal ? " · on this device" : " · not downloaded"}
          </div>
        </div>
        {item(<IconPlay size={18} />, "Play", onPlay)}
        {item(<IconPlus size={18} />, "Add to queue", onEnqueue)}
        {item(t.isFavorite ? <IconHeartFill size={18} /> : <IconHeart size={18} />, t.isFavorite ? "Remove from favorites" : "Add to favorites", onToggleFav)}
        {!isLocal && item(<IconDownload size={18} />, downloading ? "Downloading…" : "Download to this device", onDownload)}
        {isLocal && item(<IconFolder size={18} />, "Save to Files", onSave)}
        {item(<IconClose size={18} />, "Remove track", onRemove, true)}
        <button className="action-sheet-cancel" onClick={onClose} style={{ width: "100%", background: "none", border: "none", borderTop: "1px solid #2a2a2a", color: "#999", padding: "16px", fontSize: 16, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
};

const TrackListView: React.FC<{
  tracks: TrackData[];
  currentTrack: ITrack | null;
  onPlay: (t: TrackData) => void;
  onToggleFav: (t: TrackData) => void;
  onRemove: (t: TrackData) => void;
  onEnqueue?: (t: TrackData) => void;
  onDownload?: (t: TrackData) => void;
  onSave?: (t: TrackData) => void;
  onMenu?: (t: TrackData) => void;
  isDownloaded?: (id: string) => boolean;
  downloadingId?: string | null;
  lanUrl?: string;
}> = ({ tracks, currentTrack, onPlay, onToggleFav, onRemove, onEnqueue, onDownload, onSave, onMenu, isDownloaded, downloadingId, lanUrl }) => (
  <div className="track-list">
    <div className="track-list-header">
      <span className="col-fav">#</span><span className="col-title">Title</span>
      <span className="col-artist">Artist</span><span className="col-album">Album</span>
      <span className="col-dur"><IconClock size={12} style={{ marginRight: 2 }} /></span><span className="col-add" />
    </div>
    {tracks.length === 0 ? (
      <div className="track-empty">
        No tracks yet. Click the <IconUpload size={14} /> upload button to import audio files.
        {lanUrl ? " — or sync your computer's library (Settings)." : " — or connect to your computer in Settings."}
      </div>
    ) : tracks.map((t) => {
      const dl = isDownloaded?.(t.id) ?? false;
      const sourceLabel = dl
        ? "Saved on this device — plays offline"
        : "Not on this device yet — tap to download & play";
      return (
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
        <span className="col-title" title={sourceLabel}>
          <span className="track-thumb">{t.hasArtwork ? <IconImage size={14} /> : <IconMusic size={14} />}</span>
          <MarqueeText active={!!currentTrack && (currentTrack as any).id === t.id}>{t.title}</MarqueeText>
          {dl && <span className="track-badge on-device" title="Saved on this device">device</span>}
          {!dl && <span className="track-badge pending" title="Not downloaded yet — tap play to download & play">to download</span>}
        </span>
        <span className="col-artist"><MarqueeText>{t.artist}</MarqueeText></span>
        <span className="col-album"><MarqueeText>{t.album}</MarqueeText></span>
        <span className="col-dur">{formatDuration(t.durationSecs)}</span>
        <span className="col-add" title="Add to queue" onClick={(e) => { e.stopPropagation(); onEnqueue ? onEnqueue(t) : PlaybackEngine.getInstance().enqueue(toPlayableTrack(t) as any); }}>
          <IconPlus size={14} />
        </span>
        <span className="col-remove" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(t); }}>
          <IconClose size={12} />
        </span>
        {onDownload && (
          <span
            className={`col-dl ${downloadingId === t.id ? "downloading" : ""} ${dl ? "downloaded" : ""}`}
            title={sourceLabel}
            onClick={(e) => { e.stopPropagation(); if (downloadingId !== t.id) onDownload(t); }}
          >
            {downloadingId === t.id
              ? <span className="dl-spinner" />
              : dl ? <IconCheck size={13} /> : <IconDownload size={13} />}
          </span>
        )}
        {onSave && (
          <span className="col-save" title="Save to Files (find it in the Files app)" onClick={(e) => { e.stopPropagation(); onSave(t); }}>
            <IconFolder size={13} />
          </span>
        )}
        {onMenu && (
          <span className="col-menu" title="More actions" onClick={(e) => { e.stopPropagation(); onMenu(t); }}>
            <span className="dots-menu">⋯</span>
          </span>
        )}
      </div>
      );
    })}
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
  const [diag, setDiag] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  /** Run a step-by-step connectivity test so failures are exact, not vague. */
  const runDiagnostics = useCallback(async () => {
    const url = (serverUrl.trim().replace(/\/+$/, "") || lanUrl);
    if (!url) { setDiag("No server address configured — paste the LAN address from the desktop app."); return; }
    setDiagBusy(true);
    setDiag("Testing…");
    const lines: string[] = [];
    lines.push(`This page: ${window.location.origin} (${window.location.protocol})`);
    lines.push(`Server: ${url}`);
    try {
      const lib = await fetch(lanApi(url, "/api/library"));
      lines.push(`1. Library API → HTTP ${lib.status}${lib.ok ? " (reachable ✓)" : ""}`);
      if (lib.ok) {
        const data = await lib.json();
        const n = (data.tracks ?? []).length;
        lines.push(`2. Tracks on computer: ${n}`);
        if (n > 0) {
          const t = data.tracks[0];
          try {
            // Plain request (what iOS Safari's player sends first) → must be 200.
            const plain = await fetch(lanApi(url, `/audio/${encodeURIComponent(t.id)}`));
            lines.push(`3. Audio (no range) → HTTP ${plain.status}, type ${plain.headers.get("content-type") || "?"}${plain.ok ? " (player-ready ✓)" : ""}`);
            // Range request (seeking + downloads) → must be 206.
            const ranged = await fetch(lanApi(url, `/audio/${encodeURIComponent(t.id)}`), { headers: { Range: "bytes=0-0" } });
            lines.push(`4. Audio (range) → HTTP ${ranged.status}${ranged.status === 206 ? " (seek-ready ✓)" : ""}`);
          } catch (e) {
            lines.push(`3/4. Audio stream → network error: ${e}`);
          }
        }
      } else if (lib.status === 401) {
        lines.push("→ The security key is expired. Stop/Start the server in the desktop app and use the NEW address.");
      }
    } catch (e) {
      lines.push(`1. Library API → network error: ${e}`);
      if (window.location.protocol === "https:") {
        lines.push("→ This page is HTTPS. If the server is http://, the browser blocks it (mixed content) — open the LAN address from the desktop app, not the GitHub Pages site.");
      } else {
        lines.push("→ Could not reach the computer. Check: desktop app running, same Wi-Fi, firewall allows it.");
      }
    }
    setDiag(lines.join("\n"));
    setDiagBusy(false);
  }, [serverUrl, lanUrl]);

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
        <div style={{ marginTop: 8 }}>
          <button
            onClick={runDiagnostics}
            disabled={diagBusy}
            style={{ padding: "6px 12px", background: "#333", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
          >
            {diagBusy ? "Testing…" : "Test connection"}
          </button>
          {diag && (
            <pre style={{ marginTop: 8, fontSize: 11, color: "#bbb", whiteSpace: "pre-wrap", background: "#101018", border: "1px solid #2a2a3a", borderRadius: 6, padding: 8, lineHeight: 1.5 }}>{diag}</pre>
          )}
        </div>
      </div>

      {/* ── Offline listening ── */}
      <div style={{ marginBottom: 16, padding: 12, border: "1px solid #333", borderRadius: 8, background: "#14141f" }}>
        <h4 style={{ marginBottom: 8, fontSize: 14 }}>🎧 Offline listening (without the computer)</h4>
        <p style={{ fontSize: 11, color: "#999", marginBottom: 8, lineHeight: 1.5 }}>
          Downloaded tracks live inside this browser for this address only, and phones can't keep
          this page open when the computer is off. To listen without the computer:
        </p>
        <ol style={{ fontSize: 11, color: "#bbb", lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
          <li><strong>Save to Files</strong> — tap the <IconFolder size={11} style={{ verticalAlign: "middle" }} /> folder icon on a downloaded track to save the real audio file to your iPhone, or use <strong>"Save all (.zip)"</strong> next to the search bar to bundle every downloaded track into one ZIP (the Files app unzips it natively). Play anytime in the Files or Music app — no server needed.</li>
          <li><strong>Install the app</strong> — open the app at its <strong>HTTPS</strong> address (e.g. the GitHub Pages link), tap <em>Share → Add to Home Screen</em>, and it opens even offline. Then use the upload button to import the files you saved in step 1.</li>
        </ol>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            webTrackStore.clear();
            localStorage.removeItem("needmusic:tracks");
            window.location.reload();
          }}
          style={{ padding: "6px 16px", background: "#333", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
        >
          Clear All Tracks
        </button>
        <button
          onClick={async () => {
            // Full reset: tracks, playlists, downloads, and the saved LAN
            // address — then reload so the app starts completely clean.
            webTrackStore.clear();
            try { indexedDB.deleteDatabase("needmusic-downloads"); } catch { /* ignore */ }
            localStorage.removeItem("needmusic:tracks");
            localStorage.removeItem("needmusic:playlists");
            localStorage.removeItem("needmusic:lanUrl");
            localStorage.removeItem("needmusic:storageVersion");
            window.location.reload();
          }}
          style={{ padding: "6px 16px", background: "#e94560", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
        >
          Reset Everything & Reconnect
        </button>
      </div>
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
          <p>Search music from Bilibili & YouTube — playback downloads through your computer.</p>
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
/* ── Connection status chip (search bar) ── */
.lan-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid #2a2a3a;
  border-radius: 999px;
  background: #14141c;
  color: #aaa;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.lan-chip .lan-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; flex-shrink: 0; }
.lan-chip.connected { border-color: #4ecdc440; color: #4ecdc4; }
.lan-chip.connected .lan-dot { background: #4ecdc4; box-shadow: 0 0 6px #4ecdc4; }
.lan-chip.connecting { border-color: #ffc10740; color: #ffc107; }
.lan-chip.connecting .lan-dot { background: #ffc107; }
.lan-chip.error { border-color: #e9456040; color: #e94560; }
.lan-chip.error .lan-dot { background: #e94560; }

/* ── Per-track source badge ── */
.track-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .4px;
  text-transform: uppercase;
  vertical-align: middle;
  flex-shrink: 0;
}
.track-badge.on-device { background: #4ecdc422; color: #4ecdc4; border: 1px solid #4ecdc455; }
.track-badge.pending { background: #5b9cf622; color: #7ab4ff; border: 1px solid #5b9cf655; }

/* ── Library summary line ── */
.track-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  align-items: center;
  padding: 6px 12px;
  font-size: 11px;
  color: #888;
  border-bottom: 1px solid #1d1d26;
  background: #10101888;
}
.track-summary .ts-label { color: #555; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; font-size: 10px; }
.track-summary .ts-pending { color: #7ab4ff; }
.track-summary .ts-on-device { color: #4ecdc4; }

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
/* "More actions" (⋯) menu — hidden on desktop (inline buttons exist), shown
   on mobile where the per-row action icons are hidden to save space. */
.col-menu {
  width: 28px;
  text-align: center;
  color: var(--text-tertiary, #888);
  cursor: pointer;
  flex-shrink: 0;
  display: none;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}
.col-menu:hover { color: var(--accent-primary, #e94560); }
.dots-menu { font-weight: 700; letter-spacing: 1px; line-height: 1; }
.dl-spinner {
  width: 12px; height: 12px;
  border: 2px solid rgba(255,255,255,.2);
  border-top-color: var(--accent-primary, #e94560);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}

/* ── Queue & Favorites as a page tab (nav stays visible) ── */
.queue-tab { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.queue-tab .queue-panel {
  display: flex !important;
  width: 100% !important;
  min-width: 0 !important;
  flex: 1 !important;
  border-left: none !important;
}
.queue-tab .queue-panel-header { font-size: 15px !important; padding: 14px 16px !important; }
.queue-tab .queue-panel-item, .queue-tab .queue-panel-fav-item { padding: 12px 14px !important; font-size: 15px !important; }
.queue-tab .qp-title, .queue-tab .qpf-title { font-size: 15px !important; }
.queue-tab .qp-artist, .queue-tab .qpf-artist { font-size: 13px !important; }
.queue-tab .queue-play-all-btn, .queue-tab .queue-loop-btn { width: 36px !important; height: 36px !important; }
.queue-tab .queue-play-all-btn svg, .queue-tab .queue-loop-btn svg { width: 16px !important; height: 16px !important; }

/* ── Now-playing sheet (Spotify-style) ── */
.np-backdrop {
  position: fixed; inset: 0; z-index: 1300;
  background: rgba(0, 0, 0, .6);
  display: flex; align-items: flex-end; justify-content: center;
}
.now-playing-sheet {
  position: relative;
  width: 100%; max-width: 560px;
  background: #1c1c1c;
  border-radius: 20px 20px 0 0;
  padding: 10px 20px calc(24px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  animation: slideUp .3s ease;
  max-height: 92dvh; overflow-y: auto;
}
.np-grabber { width: 40px; height: 4px; border-radius: 2px; background: #3a3a4a; margin: 4px auto 0; }
.np-close { position: absolute; top: calc(12px + env(safe-area-inset-top)); right: 14px; background: none; border: none; color: #aaa; cursor: pointer; padding: 8px; }
.np-artwork {
  width: 220px; height: 220px; border-radius: 12px; flex-shrink: 0;
  background: linear-gradient(135deg, #2a2a3a, #1a1a24);
  display: flex; align-items: center; justify-content: center; color: #555;
}
.np-text { width: 100%; text-align: center; }
.np-title { font-size: 22px; font-weight: 700; }
.np-artist { color: #999; font-size: 15px; margin-top: 3px; }
.np-progress { width: 100%; }
.np-times { display: flex; justify-content: space-between; font-size: 11px; color: #777; margin-top: 4px; }
.np-controls { display: flex; align-items: center; gap: 18px; margin-top: 4px; }
.np-controls .ctrl-btn { min-width: 44px; min-height: 44px; }
.np-controls .np-play { width: 64px; height: 64px; font-size: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.np-extra { display: flex; align-items: center; gap: 18px; margin-top: 6px; width: 100%; justify-content: center; }
.np-volume { display: flex; align-items: center; gap: 8px; color: #aaa; }
.np-volume input[type="range"] { width: 120px; }
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

/* ── Track ⋯ action sheet ── */
.action-sheet-backdrop {
  position: fixed; inset: 0; z-index: 1250;
  background: rgba(0, 0, 0, .55);
  display: flex; align-items: flex-end; justify-content: center;
}
.action-sheet {
  width: 100%; max-width: 560px;
  background: #202020;
  border-radius: 18px 18px 0 0;
  padding: 8px 0 calc(16px + env(safe-area-inset-bottom));
  animation: slideUp .25s ease;
}
.action-sheet-grabber { width: 40px; height: 4px; border-radius: 2px; background: #3a3a4a; margin: 6px auto 10px; }
.action-sheet-track { padding: 8px 18px 14px; border-bottom: 1px solid #26262f; }
.action-sheet-title { font-size: 17px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.action-sheet-meta { font-size: 13px; color: #888; margin-top: 3px; }
.action-sheet-item:hover { background: #22222e; }
.action-sheet-item.danger { color: #e94560 !important; }

/* Compact player-bar play button (mobile-only; hidden on desktop) */
.player-bar-play { display: none; }

/* ── Mobile layout (≤1024px): horizontal top nav + pinned player ── */
@media (max-width: 1024px) {
  html, body { overflow: hidden; }
  .app-wrapper { height: 100dvh; }

  /* The player bar is ALWAYS visible: pinned to the bottom, with matching
     space reserved in the layout. Safe-area insets live on the layout
     container so the top nav always clears the iPhone status bar (notch /
     time & battery) and content never hides behind the player bar. */
  .app-layout {
    flex-direction: column !important;
    padding-top: calc(env(safe-area-inset-top) + 32px) !important;
    padding-bottom: calc(140px + env(safe-area-inset-bottom)) !important;
  }
  .player-bar {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    z-index: 1000 !important;
  }

  /* Desktop-only right panel takes too much room on a phone */
  .queue-panel { display: none !important; }

  /* Nav becomes a top bar (safe-area handled by .app-layout above). */
  .icon-sidebar {
    flex-direction: row !important;
    width: 100% !important;
    min-width: 0 !important;
    height: auto !important;
    padding: 8px !important;
    gap: 2px !important;
    justify-content: flex-start !important;
    border-right: none !important;
    border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.08)) !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    align-items: center !important;
  }
  .icon-nav-item { width: 54px !important; height: 54px !important; flex-shrink: 0 !important; }
  .icon-nav-item svg { width: 26px !important; height: 26px !important; }
  .icon-nav-spacer { display: none !important; }

  .main-area { width: 100% !important; flex: 1 !important; min-height: 0 !important; }
  .content-area { flex: 1 !important; min-height: 0 !important; }

  /* Search bar: stack filter + input without overflowing */
  .content-search-bar { flex-wrap: wrap !important; gap: 8px !important; padding: 8px 12px !important; }
  .content-search-bar .search-input { width: 100% !important; min-height: 50px !important; font-size: 17px !important; }
  .filter-select { padding: 12px !important; font-size: 16px !important; min-height: 50px !important; }
  .lan-chip, .online-search-btn { min-height: 46px !important; padding: 12px 16px !important; font-size: 14px !important; }

  /* Compact Spotify-style bar pinned to the bottom: info left, one play
     button right; progress/prev/next/repeat/shuffle live in the slide-up
     now-playing sheet (tap the bar to open it). */
  .player-bar {
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    align-items: center !important;
    gap: 10px !important;
    padding: 8px 14px !important;
    padding-bottom: calc(8px + env(safe-area-inset-bottom)) !important;
    min-height: 0 !important;
  }
  .player-left { order: 1 !important; flex: 1 !important; width: auto !important; min-width: 0 !important; gap: 12px !important; }
  .player-artwork { width: 44px !important; height: 44px !important; font-size: 18px !important; }
  .player-center, .player-right { display: none !important; }
  .player-bar-play { display: flex !important; order: 2 !important; width: 56px !important; height: 56px !important; flex-shrink: 0 !important; }
  .player-track-details { max-width: 100% !important; }
  .player-title { font-size: 16px !important; }
  .player-artist { font-size: 14px !important; }

  /* Track list: roomier rows, hide desktop columns */
  .track-list-header { font-size: 13px !important; padding: 14px !important; }
  .track-row { font-size: 16px !important; padding: 16px 10px !important; margin: 4px 8px !important; min-height: 64px !important; }
  .col-album, .col-artist { display: none !important; }
  .col-dur { width: 56px !important; font-size: 14px !important; }
  .col-fav { width: 52px !important; }
  /* Mobile rows show only ♥ / title / duration / ⋯ — the rest lives in the
     ⋯ action sheet so the title gets maximum room (and marquees). */
  .col-add, .col-remove, .col-dl, .col-save { display: none !important; }
  .col-menu { display: flex !important; width: 52px !important; font-size: 24px !important; }
  .track-summary { font-size: 14px !important; padding: 10px 14px !important; }
  .track-badge { font-size: 11px !important; padding: 3px 10px !important; }
  .track-empty { padding: 40px 20px !important; font-size: 16px !important; }
  .web-settings button { min-height: 52px !important; padding: 12px 18px !important; font-size: 16px !important; }

  /* Online search: full-width input, comfy rows */
  .online-search-view { padding: 14px !important; }
  .online-search-bar { flex-direction: column !important; align-items: stretch !important; gap: 10px !important; }
  .online-search-input { font-size: 17px !important; padding: 14px 16px !important; }
  .online-search-btn { padding: 14px 16px !important; font-size: 16px !important; min-height: 52px !important; }
  .online-result-row { padding: 14px 16px !important; }
  .online-result-row-actions .online-action-btn { padding: 12px 16px !important; font-size: 15px !important; min-height: 48px !important; }
  .online-error, .online-warning { font-size: 15px !important; padding: 14px 16px !important; align-items: flex-start !important; }
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
  .web-playlists > div:first-child input { font-size: 17px !important; padding: 14px !important; }
  .web-playlists > div:last-child { flex: 1 !important; min-height: 0 !important; }
  .web-playlists .track-row { min-height: 64px !important; font-size: 16px !important; }
  .web-playlists input { min-height: 52px !important; font-size: 17px !important; }

  /* Settings: readable on a phone */
  .web-settings { padding: 18px !important; font-size: 16px !important; }
  .web-settings input { font-size: 17px !important; min-height: 48px !important; }
  .web-settings h4 { font-size: 17px !important; }
  .web-settings p, .web-settings li { font-size: 15px !important; }
  .lan-connect-row { flex-wrap: wrap !important; }
  .lan-connect-row input { min-width: 100% !important; }
  .settings-row { flex-wrap: wrap !important; gap: 8px !important; }
  .settings-row input[type="range"] { flex: 1 !important; min-width: 140px !important; }
  .settings-input.short { width: 100% !important; }
}

@media (max-width: 480px) {
  .player-left .ctrl-btn { display: none !important; }
  .ctrl-btn { padding: 12px !important; }
  .play-btn { width: 56px !important; height: 56px !important; }
}
`;

if (typeof document !== "undefined") {
  const styleEl = document.createElement("style");
  styleEl.textContent = mobileStyles;
  document.head.appendChild(styleEl);
}

export default WebApp;
