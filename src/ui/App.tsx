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
import { DragBridge } from "@core/services/DragBridge";
import { CustomContextMenu, ContextMenuEntry } from "@ui/components/CustomContextMenu";
import ProgressBar from "@ui/components/ProgressBar";
import PlaylistsView from "@ui/components/PlaylistsView";
import SettingsView from "@ui/components/SettingsView";
import GoogleDriveSyncPanel from "@ui/components/GoogleDriveSyncPanel";
import OnlineSearchView from "@ui/components/OnlineSearchView";
import CustomTitleBar from "@ui/components/CustomTitleBar";
import QueuePanel from "@ui/components/QueuePanel";
import LyricsPanel from "@ui/components/LyricsPanel";
import MarqueeText from "@ui/components/MarqueeText";
import { useDesktopDriveSync, configureDesktopGoogleClientId } from "@ui/useDesktopDriveSync";
import type { DesktopDriveSync } from "@ui/useDesktopDriveSync";
import { DESKTOP_GOOGLE_CLIENT_ID, DESKTOP_GOOGLE_CLIENT_SECRET } from "@core/services/cloudConfig";
import { songKeyOf } from "@core/services/cloudsync";

// Configure the desktop build's Google OAuth client id once at module load.
configureDesktopGoogleClientId(DESKTOP_GOOGLE_CLIENT_ID);
import { LyricsService, LyricLine, findCurrentLine } from "@core/services/LyricsService";
import {
  IconLibrary, IconHeart, IconHeartFill, IconPlaylist, IconSettings,
  IconMusic, IconImage, IconPrevious, IconPlay, IconPause, IconNext, IconStop,
  IconRepeatOff, IconRepeat, IconRepeatOne, IconShuffle, IconVolume,
  IconClock, IconPlus, IconDisc, IconMic, IconGlobe, IconClose, IconHome,
  IconAlert, IconLogin,
  IconLyrics,
} from "@ui/components/Icons";
import SplashScreen from "@ui/components/SplashScreen";
import HomeView from "@ui/components/HomeView";
import UpdaterBanner from "@ui/components/UpdaterBanner";
import ConfirmDialog from "@ui/components/ConfirmDialog";
import AddToPlaylistModal from "@ui/components/AddToPlaylistModal";
import "./styles/design-tokens.css";
import "./styles/global.css";

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

const App: React.FC = () => {
  // v2 — Splash animation + Home page
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const [bgClass, setBgClass] = useState("");
  const [ready, setReady] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [activeTab, setActiveTab] = useState("Home");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterField, setFilterField] = useState("All");
  const [sortMode, setSortMode] = useState("default");
  const [queueVersion, setQueueVersion] = useState(0); // bumped on every queue mutation
  const [playlistVersion, setPlaylistVersion] = useState(0); // bumped when playlists/favorites change
  // Lyrics: fetched for the current track when it is a Bilibili online track.
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsLines, setLyricsLines] = useState<LyricLine[] | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  // Track awaiting a delete confirmation.
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null);
  // Playback failure banner (e.g. a converted track whose file is missing).
  const [playError, setPlayError] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerState>({
    currentTrack: null, playbackState: PlaybackState.Idle,
    currentTimeSecs: 0, durationSecs: 0, volume: 1, playbackRate: 1,
    repeatMode: RepeatMode.Off, isShuffled: false, isFavorite: false, buffering: false,
  });
  const engine = useMemo(() => PlaybackEngine.getInstance(), []);
  // Google Drive cross-device sync (desktop). Refreshes the library when cloud
  // data is applied and bumps the playlist version so follow-up syncs see it.
  const handleDriveSyncApplied = useCallback(async () => {
    try { await LibraryManager.getInstance().reload(); } catch { /* keep current */ }
    setTracks(LibraryManager.getInstance().getAllTracks());
    setPlaylistVersion((v) => v + 1);
  }, []);
  const driveSync = useDesktopDriveSync({
    ready,
    tracks,
    changeVersion: playlistVersion,
    onSyncedApplied: handleDriveSyncApplied,
    clientId: DESKTOP_GOOGLE_CLIENT_ID,
    clientSecret: DESKTOP_GOOGLE_CLIENT_SECRET,
  });

  // ── Drive storage UI state ──
  const [reclaimBusy, setReclaimBusy] = useState(false);
  const [reclaimResult, setReclaimResult] = useState<string | null>(null);
  const handleReclaimDriveSpace = useCallback(async () => {
    setReclaimBusy(true);
    setReclaimResult(null);
    try {
      const removed = await driveSync.reclaimDriveAudio();
      setReclaimResult(
        removed > 0
          ? `Freed ${removed} file${removed === 1 ? "" : "s"} from Drive.`
          : "Nothing to reclaim — every stored track is still in use.",
      );
    } catch (e) {
      setReclaimResult(`Could not reclaim: ${String((e as any)?.message ?? e)}`);
    } finally {
      setReclaimBusy(false);
    }
  }, [driveSync]);
  // How many songs this device wants kept available in Drive (for the panel copy).
  const driveOfflineCount = useMemo(
    () => driveSync.mergedInfo.audioRequests.size,
    [driveSync.mergedInfo.audioRequests],
  );
  // Songs that live in Drive but are NOT in this library yet — the user can pull
  // them down here. Previously such tracks were invisible on the desktop, so a
  // Drive-only song could never be downloaded onto this device.
  const driveDownloadable = useMemo(() => {
    const localKeys = new Set(tracks.map((t) => songKeyOf(t)));
    return driveSync.mergedInfo.tracks
      .filter((t) => t.driveFileId && !localKeys.has(t.songKey))
      .map((t) => ({
        songKey: t.songKey,
        title: t.title || t.songKey,
        artist: t.artist || "",
        sizeBytes: t.audioSizeBytes,
      }));
  }, [driveSync.mergedInfo.tracks, tracks]);
  const [driveDownloadingKey, setDriveDownloadingKey] = useState<string | null>(null);
  const handleDownloadDriveTrack = useCallback(async (songKey: string) => {
    setDriveDownloadingKey(songKey);
    setReclaimResult(null);
    try {
      const ok = await driveSync.downloadTrackToLibrary(songKey);
      if (!ok) {
        setReclaimResult("Couldn't download that track — sign in to Drive and check it still has audio.");
      }
    } finally {
      setDriveDownloadingKey(null);
    }
  }, [driveSync]);
  const splashStartRef = useRef(performance.now());
  const keydownCleanupRef = useRef<(() => void) | null>(null);
  const hotkeyUnlistenRef = useRef<(() => void) | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // Listening-time accounting for the activity stats: `onProgressChange` ticks
  // ~4x/second, so we accumulate real seconds here and bank them in batches.
  const listenRef = useRef({ lastPos: 0, pending: 0, playing: false });
  // Late-bound handle to the Drive sync (created further down) so the player
  // callbacks can persist resume positions without a circular dependency.
  const driveSyncRef = useRef<DesktopDriveSync | null>(null);
  // The track the player is currently on (resume positions are written for it).
  const currentTrackRef = useRef<Track | ITrack | null>(null);
  // Publish the Drive handle for the player callbacks below.
  driveSyncRef.current = driveSync;

  /**
   * Persist the seconds listened since the last flush. Only whole seconds are
   * written (the fractional remainder stays in `pending`), so repeated calls
   * never lose time to rounding.
   */
  const flushListening = useCallback(() => {
    const L = listenRef.current;
    const whole = Math.floor(L.pending);
    if (whole < 1) return;
    L.pending -= whole;
    DatabaseManager.getInstance()
      .addListeningSeconds(whole)
      .then(() => window.dispatchEvent(new CustomEvent("listeningActivity")))
      .catch(() => { /* stats are best-effort */ });
  }, []);

  /**
   * Persist where playback stopped for the CURRENT track, so another device can
   * resume there (LWW by timestamp). Throttled: only written every
   * POSITION_FLUSH_MS and only when it moved by more than a few seconds, so a
   * running player doesn't rewrite Drive every sync cycle.
   */
  const POSITION_FLUSH_MS = 30000;
  const positionRef = useRef({ songKey: "", secs: 0, lastAt: 0 });
  const flushPosition = useCallback((currentTrack: Track | ITrack | null, secs: number) => {
    if (!currentTrack || !(secs > 5)) return;
    const key = songKeyOf(currentTrack as any);
    if (!key) return;
    const P = positionRef.current;
    const now = Date.now();
    const sameSong = P.songKey === key;
    const movedEnough = Math.abs(secs - P.secs) > 5;
    if (sameSong && now - P.lastAt < POSITION_FLUSH_MS && !movedEnough) return;
    positionRef.current = { songKey: key, secs, lastAt: now };
    driveSyncRef.current?.setResumePosition(key, secs).catch(() => { /* best-effort */ });
  }, []);

  // Bank whatever is still pending when the window closes or is hidden —
  // otherwise the last <15s before quitting would be lost.
  useEffect(() => {
    const onHide = () => flushListening();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      flushListening();
    };
  }, [flushListening]);

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

      // Pre-install ffmpeg in the background (MP3 conversion dependency).
      invoke("ensure_ffmpeg_installed").catch(() => {});

      // Keep yt-dlp installed AND current in the background. A stale yt-dlp is
      // what breaks YouTube downloads ("Requested format is not available"), so
      // this runs on every launch and never asks the user to update it.
      invoke("ensure_ytdlp_ready").catch(() => {});

      // The LAN server is no longer started automatically. Start it manually
      // from Settings → LAN Sync whenever needed (avoids opening a port on
      // every launch by default).

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
        onStateChange: (s) => {
          const L = listenRef.current;
          const nowPlaying = s === PlaybackState.Playing;
          // Bank the elapsed time as soon as playback stops (pause/stop/end).
          if (L.playing && !nowPlaying) {
            L.playing = false;
            flushListening();
            // Remember where we stopped so another device can resume here.
            flushPosition(currentTrackRef.current, L.lastPos);
          } else if (!L.playing && nowPlaying) {
            L.playing = true;
          }
          setPlayer((p) => ({ ...p, playbackState: s }));
        },
        onTrackChange: (t) => {
          // The new track restarts at 0 — bank the previous track's time first
          // and reset the position baseline so the jump isn't counted.
          flushListening();
          flushPosition(currentTrackRef.current, listenRef.current.lastPos);
          listenRef.current.lastPos = 0;
          currentTrackRef.current = (t as Track) ?? null;
          if (t) {
            DatabaseManager.getInstance().recordPlay().catch(() => {});
            // Resume where this song was last left (synced from any device).
            const resumeSecs = Number((t as Track).resumePositionSecs) || 0;
            const dur = Number(t.durationSecs) || 0;
            if (resumeSecs > 5 && (!dur || resumeSecs < dur - 10)) {
              const id = (t as Track).id;
              // Give the audio sink a moment to load, then only seek if we are
              // still on the same track (the user may have skipped already).
              window.setTimeout(() => {
                try {
                  if (engine.currentTrack?.id === id) {
                    engine.seek(resumeSecs).catch(() => { /* ignore */ });
                  }
                } catch { /* ignore */ }
              }, 400);
            }
          }
          setPlayer((p) => ({
            ...p, currentTrack: t, currentTimeSecs: 0,
            durationSecs: t?.durationSecs ?? p.durationSecs,
            isFavorite: (t as Track)?.isFavorite ?? false,
          }));
        },
        onProgressChange: (cur, dur) => {
          const L = listenRef.current;
          if (L.playing) {
            const delta = cur - L.lastPos;
            // Ignore seeks: only count small forward steps between ticks.
            if (delta > 0 && delta <= 5) L.pending += delta;
            if (L.pending >= 15) flushListening();
            // Throttled inside: writes at most every 30s per track.
            flushPosition(currentTrackRef.current, cur);
          }
          L.lastPos = cur;
          setPlayer((p) => ({
            ...p,
            currentTimeSecs: cur,
            durationSecs: dur > 0 ? dur : p.durationSecs,
          }));
        },
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
          // Current lyric line (main window decides the line; the island
          // window renders it only when its own setting is enabled).
          const lyricLines = lyricsLinesRef.current;
          const lyric = lyricLines && lyricLines.length > 0
            ? (lyricLines[findCurrentLine(lyricLines, curTime)]?.text ?? null)
            : null;
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
            lyric,
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

      // ── Keyboard Shortcuts (Spacebar, etc.) ──
      const handleKeyDown = (e: KeyboardEvent) => {
        // Don't intercept when typing in input fields
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;

        // Spacebar → Play/Pause
        if (e.code === "Space" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (engine.state === PlaybackState.Playing) {
            engine.pause();
          } else {
            engine.resume();
          }
          return;
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      keydownCleanupRef.current = () => document.removeEventListener("keydown", handleKeyDown);

      // ── Mouse-event-based drag bridge (bypasses broken HTML5 DnD in Tauri/WebView2) ──
      const handleMouseMove = (e: MouseEvent) => {
        DragBridge.onMouseMove(e.clientX, e.clientY, e.buttons);
      };
      const handleMouseUp = (e: MouseEvent) => {
        // Always end (and reset) the drag on mouseup — even for a plain click.
        // Previously this returned early when not dragging, leaking stale drag
        // state that made the queue highlight after double-clicks and forced a
        // "click once to add" after dragging to the queue.
        const trackId = DragBridge.endMouseDrag();
        if (!trackId) return;

        try {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const queuePanel = el?.closest(".queue-panel") as HTMLElement | null;

          if (queuePanel) {
            const allTracks = LibraryManager.getInstance().getAllTracks();
            const track = allTracks.find((t) => t.id === trackId);
            if (track) {
              engine.enqueue(track);
              setQueueVersion(v => v + 1);
            }
          }
        } catch (err) {
          console.error("[App] mouseup drag handler error:", err);
          DragBridge.clear();
        }
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      // ── Global Hotkey Actions (from Rust backend) ──
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<string>("hotkey-action", (event) => {
          const action = event.payload;
          switch (action) {
            case "playpause":
              if (engine.state === PlaybackState.Playing) engine.pause();
              else engine.resume();
              break;
            case "next":
              engine.next();
              break;
            case "previous":
              engine.previous();
              break;
            case "stop":
              engine.stop();
              break;
            case "loop":
              // Cycle: Off → Track → Playlist → Off
              const modes = [RepeatMode.Off, RepeatMode.Track, RepeatMode.Playlist];
              const currentIdx = modes.indexOf(engine.repeatMode);
              engine.repeatMode = modes[(currentIdx + 1) % modes.length];
              setPlayer((p) => ({ ...p, repeatMode: engine.repeatMode }));
              break;
            case "shuffle":
              setPlayer((p) => ({ ...p, isShuffled: !p.isShuffled }));
              break;
            case "volup":
              engine.setVolume(Math.min(1, engine.volume + 0.05));
              setPlayer((p) => ({ ...p, volume: engine.volume }));
              break;
            case "voldown":
              engine.setVolume(Math.max(0, engine.volume - 0.05));
              setPlayer((p) => ({ ...p, volume: engine.volume }));
              break;
          }
        });
        hotkeyUnlistenRef.current = unlisten;
      } catch { /* ignore */ }

      // ── Register saved global hotkeys on startup ──
      try {
        const savedHotkeys = await db.getSetting("hotkeys");
        if (savedHotkeys) {
          const parsed = JSON.parse(savedHotkeys);
          for (const hk of parsed) {
            if (hk.isGlobal) {
              invoke("register_hotkey", {
                hotkeyId: hk.id,
                key: hk.key,
                modifiers: hk.modifiers || [],
                action: hk.action,
              }).catch(() => { /* hotkey may already be registered */ });
            }
          }
        }
      } catch { /* ignore */ }

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
      // Ensure splash screen is visible for at least 3 seconds
      const minSplashMs = 3000;
      const elapsed = performance.now() - splashStartRef.current;
      const remaining = Math.max(0, minSplashMs - elapsed);
      setTimeout(() => {
        setSplashFading(true);
        setTimeout(() => {
          setReady(true);
          console.log("[NeedMusic] App ready.");
        }, 500); // fade-out duration
      }, remaining);
    }).catch((err) => {
      clearTimeout(timeoutId);
      const msg = String(err);
      console.error("[NeedMusic] Initialization error:", msg, err);
      setError(msg);
    });
    return () => { clearTimeout(timeoutId); if (islandInterval) clearInterval(islandInterval); keydownCleanupRef.current?.(); hotkeyUnlistenRef.current?.(); dragCleanupRef.current?.(); BackgroundEngine.getInstance().unmount(); };
  }, [engine]);

  // ── Lyrics: fetch when the current track changes ──
  const lyricsLinesRef = useRef<LyricLine[] | null>(null);
  useEffect(() => {
    const track = player.currentTrack as Track | null;
    setLyricsLines(null);
    setLyricsLoading(false);
    lyricsLinesRef.current = null;
    if (!track || track.onlineSource !== "bilibili") {
      return;
    }
    const bvid = track.filePath.slice(Track.ONLINE_BILIBILI_PREFIX.length);
    setLyricsLoading(true);
    LyricsService.getLyrics(track.id, bvid)
      .then((lines) => {
        lyricsLinesRef.current = lines;
        setLyricsLines(lines);
      })
      .catch(() => {
        lyricsLinesRef.current = null;
        setLyricsLines(null);
      })
      .finally(() => setLyricsLoading(false));
  }, [player.currentTrack?.id]);

  // ── LAN Sync (experimental): keep the LAN server's library AND playlists in sync ──
  useEffect(() => {
    invoke("lan_set_library", {
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        filePath: t.filePath,
        durationSecs: t.durationSecs,
      })),
    }).catch((e) => console.warn("[NeedMusic] LAN library sync failed:", e));

    // Playlists + favorites live in SQLite; push them so the phone sees the
    // same playlists and hearts as the desktop.
    (async () => {
      const db = DatabaseManager.getInstance();
      try {
        const playlists = await db.getAllPlaylists();
        const entries: { id: string; name: string; trackIds: string[] }[] = [];
        for (const pl of playlists) {
          const pts = await db.getPlaylistTracks(pl.id);
          entries.push({ id: pl.id, name: pl.name, trackIds: pts.map((t) => t.id) });
        }
        await invoke("lan_set_playlists", {
          playlists: entries,
          favoriteIds: tracks.filter((t) => t.isFavorite).map((t) => t.id),
        });
      } catch { /* DB/commands unavailable — non-fatal */ }
    })();
  }, [tracks, playlistVersion]);

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

  const handlePlayTrack = useCallback(async (track: Track) => {
    setPlayError(null);
    try {
      await engine.play(track);
    } catch (e: any) {
      // Show why playback failed AND the exact path it tried to open, so a
      // stale .m4a entry vs. a wrong .mp3 path is immediately visible.
      setPlayError(`Couldn't play "${track.title}": ${(e && e.message) || e}\nFile: ${track.filePath}`);
    }
  }, [engine]);

  const handleToggleFavorite = useCallback(async (track: Track, force?: boolean) => {
    const next = force ?? !track.isFavorite;
    track.isFavorite = next;
    await DatabaseManager.getInstance().setFavorite(track.id, next);
    // Mark this song as favorite-touched on this device so the LWW sync honors
    // this toggle (favorite AND un-favorite both propagate to other devices).
    driveSync.touchFavorite(songKeyOf(track));
    setTracks([...tracks]);
    setPlaylistVersion((v) => v + 1); // favorites playlist changed → re-sync LAN
    if (player.currentTrack?.id === track.id) setPlayer((p) => ({ ...p, isFavorite: next }));
    if (driveSync.signedIn) driveSync.runSync();
  }, [tracks, player.currentTrack, driveSync]);

  const handleRemoveTrack = useCallback((track: Track) => {
    // Ask for confirmation before permanently deleting anything.
    setPendingDelete(track);
  }, []);

  const confirmDeleteTrack = useCallback(async (track: Track) => {
    // If currently playing this track, stop playback first.
    if (player.currentTrack?.id === track.id) {
      engine.stop();
    }
    const db = DatabaseManager.getInstance();
    // Remove from Favorites (also cleans the ★ Favorites playlist row).
    if (track.isFavorite) {
      await db.setFavorite(track.id, false);
    }
    // Delete the actual audio file from disk (online tracks are virtual).
    if (!track.isOnlineTrack()) {
      try {
        await invoke("delete_track_file", { filePath: track.filePath });
      } catch (e) {
        console.warn("[NeedMusic] Failed to delete file (library entry still removed):", e);
      }
    }
    await LibraryManager.getInstance().removeTrack(track.id);
    setTracks(LibraryManager.getInstance().getAllTracks());
    setPlaylistVersion((v) => v + 1); // cascade may have touched playlists → re-sync LAN
    // Record an explicit deletion so it propagates to Drive and other devices.
    // Always record locally (persisted), even when not signed in — otherwise a
    // track that has a Drive copy (or a stale record) would be re-materialized
    // on the next sync and appear to "come back" after deletion.
    driveSync.queueDeletion(songKeyOf(track));
    if (driveSync.signedIn) {
      // Push the deletion to Drive immediately (like the web app does) so a
      // removed track can't be pulled back from Drive before the periodic sync.
      driveSync.runSync();
    }
    setPendingDelete(null);
  }, [player.currentTrack, engine, driveSync]);

  const handleTitleChange = useCallback(async (track: Track, newTitle: string) => {
    const db = DatabaseManager.getInstance();
    // Persist to the audio file's metadata tags (skipped for online tracks,
    // which have no local audio file).
    if (!track.isOnlineTrack()) {
      invoke("write_track_metadata", {
        filePath: track.filePath,
        title: newTitle,
        artist: null,
        album: null,
      }).catch((err) => console.warn("[NeedMusic] Failed to write metadata to file:", err));
    }
    // Update the database.
    await db.updateTrackMetadata(track.id, { title: newTitle });
    // Update local state so the UI re-renders.
    setTracks((prev) => [...prev]);
  }, []);

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
    <SplashScreen
      error={error}
      onRetry={() => { setError(null); setReady(false); window.location.reload(); }}
    />
  );
  if (!ready) return <SplashScreen fading={splashFading} />;

  const ct = player.currentTrack;
  const isPlaying = player.playbackState === PlaybackState.Playing;

  return (
    <div className="app-wrapper">
      <CustomTitleBar />
      <UpdaterBanner />
      {playError && (
        <div className="update-banner update-banner-error">
          <div className="update-banner-icon"><IconAlert size={16} /></div>
          <div className="update-banner-text">
            <strong>Playback failed</strong>
            <span className="update-banner-sub" style={{ whiteSpace: "pre-line" }}>{playError}</span>
          </div>
          <div className="update-banner-actions">
            <button className="update-banner-dismiss" onClick={() => setPlayError(null)} title="Dismiss"><IconClose size={12} /></button>
          </div>
        </div>
      )}
      <div className="custom-bg-layer" />
      <canvas ref={bgCanvasRef} className={`bg-canvas ${bgClass}`} />
      <div className="app-layout" onContextMenu={handleContextMenu}>
        <nav className="icon-sidebar">
          <div className={`icon-nav-item ${activeTab === "Home" ? "active" : ""}`} onClick={() => setActiveTab("Home")} title="Home"><IconHome size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Tracks" ? "active" : ""}`} onClick={() => setActiveTab("Tracks")} title="Tracks"><IconLibrary size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Albums" ? "active" : ""}`} onClick={() => setActiveTab("Albums")} title="Albums"><IconDisc size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Artists" ? "active" : ""}`} onClick={() => setActiveTab("Artists")} title="Artists"><IconMic size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Playlists" ? "active" : ""}`} onClick={() => setActiveTab("Playlists")} title="Playlists"><IconPlaylist size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Online" ? "active" : ""}`} onClick={() => setActiveTab("Online")} title="Online"><IconGlobe size={18} /></div>
          <div className="icon-nav-spacer" />
          <div className={`icon-nav-item ${activeTab === "Settings" ? "active" : ""}`} onClick={() => setActiveTab("Settings")} title="Settings"><IconSettings size={18} /></div>
          <div className={`icon-nav-item ${activeTab === "Drive" ? "active" : ""}`} onClick={() => setActiveTab("Drive")} title="Google Drive Sync"><IconLogin size={18} /></div>
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
              <select
                className="filter-select"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value)}
                title="Sort tracks"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
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
            {activeTab === "Home" ? <HomeView tracks={tracks} currentTrack={ct as Track | null} onPlay={handlePlayTrack} /> :
             activeTab === "Albums" ? <AlbumsView tracks={filteredTracks} onPlay={handlePlayTrack} /> :
             activeTab === "Artists" ? <ArtistsView tracks={filteredTracks} /> :
             activeTab === "Playlists" ? <PlaylistsView tracks={tracks} onChanged={() => setPlaylistVersion((v) => v + 1)} /> :
             activeTab === "Online" ? (
               <OnlineSearchView
                 onTrackSaved={() => setTracks(LibraryManager.getInstance().getAllTracks())}
               />
             ) :
             activeTab === "Drive" ? (
               <div className="track-list" style={{ padding: 24 }}>
                 <GoogleDriveSyncPanel
                   signedIn={driveSync.signedIn}
                   account={driveSync.account}
                   status={driveSync.status}
                   hasConfig={driveSync.hasConfig}
                   onSignIn={driveSync.signIn}
                   onSignOut={driveSync.signOut}
                   onUpload={driveSync.upload}
                   onDownload={driveSync.download}
                   onClean={() => {
                     if (window.confirm("Delete ALL Google Drive sync data (sync list + uploaded audio), reset this device's sync state, AND remove every track from this device (library + audio files)? This is permanent and cannot be undone.")) {
                       driveSync.clean().catch(() => { /* keep UI stable */ });
                     }
                   }}
                   onOpenGuide={() => {
                     try { window.open("https://github.com/Revampes/NeedMusic/blob/main/docs/google-drive-sync.md", "_blank"); } catch { /* ignore */ }
                   }}
                   audioMode={driveSync.audioMode}
                   onAudioModeChange={driveSync.setAudioMode}
                   offlineCount={driveOfflineCount}
                   onReclaimDriveSpace={() => { void handleReclaimDriveSpace(); }}
                   reclaimBusy={reclaimBusy}
                   reclaimResult={reclaimResult}
                   downloadableTracks={driveDownloadable}
                   onDownloadTrack={(key) => { void handleDownloadDriveTrack(key); }}
                   downloadingKey={driveDownloadingKey}
                 />
               </div>
             ) :
             activeTab === "Settings" ? (
               <SettingsView
                 onTracksLoaded={setTracks}
               />
             ) :
             <TrackListView tracks={filteredTracks} currentTrack={ct} onPlay={handlePlayTrack} onToggleFav={handleToggleFavorite} onRemove={handleRemoveTrack} onTitleChange={handleTitleChange} onPlaylistChanged={(ids) => { ids?.forEach((id) => driveSync.touchPlaylist(id)); setPlaylistVersion((v) => v + 1); }} driveSync={driveSync} />}
          </div>
        </div>
          {showLyrics ? (
            <LyricsPanel
              track={ct as Track | null}
              currentTimeSecs={player.currentTimeSecs}
              onClose={() => setShowLyrics(false)}
            />
          ) : (
            <QueuePanel libraryTracks={tracks} queueVersion={queueVersion} onAddFavorite={(t) => handleToggleFavorite(t as Track, true)} />
          )}
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
          {/* Lyrics toggle (only for Bilibili tracks, which may carry lyrics) */}
          {ct && (ct as Track).onlineSource === "bilibili" && (
            <button
              className={`ctrl-btn ${showLyrics ? "active" : ""}`}
              onClick={() => setShowLyrics((v) => !v)}
              title={showLyrics ? "Close lyrics" : lyricsLoading ? "Loading lyrics…" : lyricsLines && lyricsLines.length > 0 ? "Show lyrics" : "No lyrics available"}
            >
              <IconLyrics size={15} />
            </button>
          )}
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
            <span className="volume-value">{Math.round(player.volume * 100)}%</span>
          </div>
        </div>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.title}”?`}
          message={pendingDelete.isOnlineTrack() ? (
            <>This removes the track from your library and from any playlists, including <strong>★ Favorites</strong>.</>
          ) : (
            <>This permanently deletes the audio file from your computer and removes the track from your library, playlists, and <strong>★ Favorites</strong>.<br /><span style={{ fontSize: 11, opacity: 0.7 }}>{pendingDelete.filePath}</span></>
          )}
          confirmLabel="Delete"
          danger
          onConfirm={() => confirmDeleteTrack(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
};

export default App;

// ─── Sub-Views ────────────────────────────────────────

const TrackListView: React.FC<{ tracks: Track[]; currentTrack: ITrack | null; onPlay: (t: Track) => void; onToggleFav: (t: Track) => void; onRemove: (t: Track) => void; onTitleChange: (t: Track, newTitle: string) => void; onPlaylistChanged?: (touchedPlaylistIds: string[]) => void; driveSync?: DesktopDriveSync }> =
  ({ tracks, currentTrack, onPlay, onToggleFav, onRemove, onTitleChange, onPlaylistChanged, driveSync }) => {
    const [editingId, setEditingId] = React.useState<string | null>(null);
    const [editValue, setEditValue] = React.useState("");
    const [playlistTarget, setPlaylistTarget] = React.useState<Track | null>(null);

    const startEdit = (t: Track) => {
      setEditingId(t.id);
      setEditValue(t.title);
    };

    const commitEdit = (t: Track) => {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== t.title) {
        onTitleChange(t, trimmed);
        t.title = trimmed; // optimistic UI update
      }
      setEditingId(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent, t: Track) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit(t);
      } else if (e.key === "Escape") {
        setEditingId(null);
      }
    };

    return (
    <div className="track-list">
      <div className="track-list-header">
        <span className="col-fav">#</span><span className="col-title">Title</span>
        <span className="col-artist">Artist</span><span className="col-album">Album</span>
        <span className="col-dur"><IconClock size={12} style={{ marginRight: 2 }} /></span><span className="col-rate" /><span className="col-offline" title="Available offline / in Drive">☁</span><span className="col-add" /><span className="col-remove" />
      </div>
      {tracks.length === 0 ? <div className="track-empty">No tracks found.</div> : tracks.map((t) => (
        <div
          key={t.id}
          className={`track-row ${currentTrack?.id === t.id ? "active" : ""}`}
          onMouseDown={(e) => {
            // Primary drag mechanism for Tauri/WebView2 (mouse-event-based).
            // Note: no native `draggable`/HTML5 DnD here — WebView2's native
            // drag swallows the mouseup so the queue drop would never register
            // on release (it required an extra click). The mouse-event path in
            // DragBridge handles track → queue drags reliably.
            if (e.button !== 0) return;
            const target = e.target as HTMLElement;
            if (target.closest("button, input, .fav-btn, .col-remove, .col-add")) return;
            DragBridge.startMouseDrag(t.id, e.clientX, e.clientY);
          }}
          onDoubleClick={() => onPlay(t)}
        >
          <span className="col-fav fav-btn" onClick={(e) => { e.stopPropagation(); onToggleFav(t); }}>{t.isFavorite ? <IconHeartFill size={13} /> : <IconHeart size={13} />}</span>
          <span className="col-title">
            <span className="track-thumb">{t.hasArtwork ? <IconImage size={14} /> : <IconMusic size={14} />}</span>
            {editingId === t.id ? (
              <input
                className="track-title-edit-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitEdit(t)}
                onKeyDown={(e) => handleKeyDown(e, t)}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="track-title-text"
                title="Click to edit title"
                onClick={(e) => { e.stopPropagation(); startEdit(t); }}
              >
                <span className="multiline-text">{t.title}</span>
                {t.isOnlineTrack() && (
                  <span className="track-online-badge" title="Saved without downloading — plays via the source API">Online</span>
                )}
              </span>
            )}
          </span>
          <span className="col-artist"><span className="multiline-text">{t.artist}</span></span>
          <span className="col-album"><span className="multiline-text">{t.album}</span></span>
          <span className="col-dur">{t.formatDuration()}</span>
          <span className="col-rate" onClick={(e) => e.stopPropagation()}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`rate-star ${Track.clampRating(t.rating) >= n ? "on" : ""}`}
                title={Track.clampRating(t.rating) === n ? "Clear rating" : `Rate ${n} of 5`}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = Track.clampRating(t.rating) === n ? 0 : n;
                  if (driveSync) void driveSync.setRating(songKeyOf(t), next);
                }}
              >{Track.clampRating(t.rating) >= n ? "★" : "☆"}</button>
            ))}
          </span>
          <span
            className={`col-offline ${driveSync?.mergedInfo.audioRequests.has(songKeyOf(t)) ? "on" : ""}`}
            title={driveSync?.mergedInfo.audioRequests.has(songKeyOf(t))
              ? "Available offline — click to stop keeping it in Drive"
              : "Keep this song available offline (uploads its audio to Drive)"}
            onClick={(e) => {
              e.stopPropagation();
              if (!driveSync) return;
              const key = songKeyOf(t);
              driveSync.setTrackOffline(key, !driveSync.mergedInfo.audioRequests.has(key));
            }}
          >☁</span>
          <span className="col-add" title="Add to playlist" onClick={(e) => { e.stopPropagation(); setPlaylistTarget(t); }}><IconPlus size={14} /></span>
          <span className="col-remove" title="Remove from library" onClick={(e) => { e.stopPropagation(); onRemove(t); }}><IconClose size={12} /></span>
        </div>
      ))}
      {playlistTarget && (
        <AddToPlaylistModal
          track={playlistTarget}
          onClose={() => setPlaylistTarget(null)}
          onChanged={onPlaylistChanged}
        />
      )}
    </div>
  );
};

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
