import {
  IAudioOutput,
  IPlaybackObserver,
  ITrack,
  PlaybackState,
  RepeatMode,
} from "@core/interfaces";
import { invoke } from "@tauri-apps/api/core";
import { DiscordRpcService } from "./DiscordRpcService";

export { PlaybackState, RepeatMode };

/**
 * Singleton playback engine — the heart of NeedMusic's audio pipeline.
 * Manages track queue, audio output, and notifies observers of state changes.
 *
 * Design Pattern: Singleton + Observer
 */
export class PlaybackEngine {
  private static instance: PlaybackEngine | null = null;

  private audioOutput: IAudioOutput | null = null;
  private observers: Set<IPlaybackObserver> = new Set();
  private queue: ITrack[] = [];
  private currentIndex: number = -1;

  /**
   * Holds the currently-playing track when it was started via {@link play}
   * and is not in the queue.  When null the current track is read from the
   * queue at {@link currentIndex}.
   */
  private _playingTrack: ITrack | null = null;

  private _state: PlaybackState = PlaybackState.Idle;
  private _volume: number = 1.0;
  private _playbackRate: number = 1.0;
  private _repeatMode: RepeatMode = RepeatMode.Off;

  private progressInterval: ReturnType<typeof setInterval> | null = null;
  private _isHandlingTrackEnd = false;

  // ── Sink-stall detection (e.g. silent playback after OS sleep) ──
  private stallCheckTick = 0;
  private lastRustPos = -1.0;
  private lastClientPosAtRust = 0.0;
  /** Bumped on every sink rebuild so stale stall checks can be discarded. */
  private seekVersion = 0;

  private constructor() {}

  // ─── Singleton Access ──────────────────────────────────────

  static getInstance(): PlaybackEngine {
    if (!PlaybackEngine.instance) {
      PlaybackEngine.instance = new PlaybackEngine();
    }
    return PlaybackEngine.instance;
  }

  /**
   * For testing — destroys the singleton so a fresh instance can be created.
   */
  static resetInstance(): void {
    const inst = PlaybackEngine.instance;
    if (inst) {
      inst.destroy();
      PlaybackEngine.instance = null;
    }
  }

  // ─── Initialization ─────────────────────────────────────────

  /**
   * Sets the audio output backend. Must be called before playback.
   */
  setAudioOutput(output: IAudioOutput): void {
    this.audioOutput = output;
  }

  // ─── Observer Management ────────────────────────────────────

  subscribe(observer: IPlaybackObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  // ─── State Accessors ────────────────────────────────────────

  get state(): PlaybackState {
    return this._state;
  }

  get volume(): number {
    return this._volume;
  }

  get repeatMode(): RepeatMode {
    return this._repeatMode;
  }

  set repeatMode(mode: RepeatMode) {
    this._repeatMode = mode;
  }

  get currentTrack(): ITrack | null {
    // A track started via play() may live outside the queue.
    if (this._playingTrack) return this._playingTrack;
    if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
      return null;
    }
    return this.queue[this.currentIndex] ?? null;
  }

  get queueTracks(): ITrack[] {
    return [...this.queue];
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get currentIndex_(): number {
    return this.currentIndex;
  }

  // ─── Playback Controls ──────────────────────────────────────

  /**
   * Load a track and start playback without modifying the queue.
   * Use {@link enqueue} or {@link setQueue} to manage the queue explicitly.
   */
  async play(track: ITrack): Promise<void> {
    if (!this.audioOutput) {
      console.error("[PlaybackEngine] No audio output set.");
      return;
    }

    // If the track is already in the queue, sync currentIndex so
    // next/previous navigation stays consistent.
    const existingIdx = this.queue.findIndex((t) => t.id === track.id);
    if (existingIdx >= 0) {
      this.currentIndex = existingIdx;
      this._playingTrack = null; // playing from queue
    } else {
      this._playingTrack = track; // playing outside queue
    }

    await this.audioOutput.play(track.filePath);
    this.audioOutput.setVolume(this._volume);
    this.audioOutput.setPlaybackRate(this._playbackRate);
    this.resetStallBaseline(); // new sink — restart stall detection baseline
    this.setState(PlaybackState.Playing);
    this.startProgressUpdates();
    this.notifyTrackChange();
    this.syncDiscordPresence(true);
  }

  pause(): void {
    this.audioOutput?.pause();
    this.setState(PlaybackState.Paused);
    this.stopProgressUpdates();
    this.syncDiscordPresence(false);
  }

  resume(): void {
    this.audioOutput?.resume();
    this.setState(PlaybackState.Playing);
    this.startProgressUpdates();
    this.syncDiscordPresence(true);
  }

  stop(): void {
    this.audioOutput?.stop();
    this.setState(PlaybackState.Stopped);
    this.stopProgressUpdates();
    this.currentIndex = -1;
    this._playingTrack = null;
    this.notifyTrackChange();
    DiscordRpcService.getInstance().clearPresence();
  }

  /**
   * Play the next track in the queue.
   */
  async next(): Promise<void> {
    if (this.queue.length === 0) return;

    let nextIdx = this.currentIndex + 1;

    if (nextIdx >= this.queue.length) {
      if (this._repeatMode === RepeatMode.Playlist) {
        nextIdx = 0;
      } else {
        this.stop();
        return;
      }
    }

    const track = this.queue[nextIdx];
    if (track) {
      this.currentIndex = nextIdx;
      this._playingTrack = null; // playing from queue now
      await this.audioOutput?.play(track.filePath);
      this.audioOutput?.setVolume(this._volume);
      this.resetStallBaseline();
      this.setState(PlaybackState.Playing);
      this.startProgressUpdates();
      this.notifyTrackChange();
      this.syncDiscordPresence(true);
    }
  }

  /**
   * Play the previous track in the queue.
   */
  async previous(): Promise<void> {
    if (this.queue.length === 0) return;

    // If more than 3 seconds in, restart current track instead.
    const currentTime = this.audioOutput?.getCurrentTime() ?? 0;
    if (currentTime > 3) {
      await this.seek(0);
      return;
    }

    let prevIdx = this.currentIndex - 1;
    if (prevIdx < 0) {
      if (this._repeatMode === RepeatMode.Playlist) {
        prevIdx = this.queue.length - 1;
      } else {
        // Restart current track.
        prevIdx = this.currentIndex;
      }
    }

    const track = this.queue[prevIdx];
    if (track) {
      this.currentIndex = prevIdx;
      this._playingTrack = null; // playing from queue now
      await this.audioOutput?.play(track.filePath);
      this.audioOutput?.setVolume(this._volume);
      this.resetStallBaseline();
      this.setState(PlaybackState.Playing);
      this.startProgressUpdates();
      this.notifyTrackChange();
      this.syncDiscordPresence(true);
    }
  }

  async seek(seconds: number): Promise<void> {
    this.resetStallBaseline(); // a seek rebuilds the sink — start baseline fresh
    await this.audioOutput?.seek(seconds);
    // Refresh Discord RPC so the progress bar reflects the new position.
    const isPlaying = this._state === PlaybackState.Playing;
    if (isPlaying || this._state === PlaybackState.Paused) {
      this.syncDiscordPresence(isPlaying);
    }
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    this.audioOutput?.setVolume(this._volume);
    this.notifyVolumeChange();
  }

  setPlaybackRate(rate: number): void {
    this._playbackRate = Math.max(0.25, Math.min(4, rate));
    this.audioOutput?.setPlaybackRate(this._playbackRate);
  }

  getPlaybackRate(): number {
    return this._playbackRate;
  }

  /** Returns the current playback position in seconds from the audio output. */
  getCurrentTime(): number {
    return this.audioOutput?.getCurrentTime() ?? 0;
  }

  /** Returns the total duration in seconds (prefers metadata, falls back to decoder). */
  getDuration(): number {
    const audioDur = this.audioOutput?.getDuration() ?? 0;
    const trackDur = this.currentTrack?.durationSecs ?? 0;
    return trackDur > 0 ? trackDur : audioDur;
  }

  // ─── Queue Management ───────────────────────────────────────

  enqueue(track: ITrack): void {
    this.queue.push(track);
    this.notifyTrackChange();
  }

  enqueueAll(tracks: ITrack[]): void {
    this.queue.push(...tracks);
    this.notifyTrackChange();
  }

  removeFromQueue(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    if (index === this.currentIndex) {
      this.stop();
    }
    this.queue.splice(index, 1);
    if (index < this.currentIndex) {
      this.currentIndex--;
    }
    this.notifyTrackChange();
  }

  clearQueue(): void {
    this.stop();
    this.queue = [];
    this.currentIndex = -1;
  }

  /**
   * Set the entire queue and optionally start playing.
   */
  async setQueue(tracks: ITrack[], startIndex: number = 0): Promise<void> {
    this.queue = [...tracks];
    this.currentIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
    this._playingTrack = null; // playing from queue
    const track = this.queue[this.currentIndex];
    if (track) {
      await this.audioOutput?.play(track.filePath);
      this.audioOutput?.setVolume(this._volume);
      this.resetStallBaseline();
      this.setState(PlaybackState.Playing);
      this.startProgressUpdates();
      this.notifyTrackChange();
      this.syncDiscordPresence(true);
    }
  }

  // ─── Notifications ──────────────────────────────────────────

  private setState(newState: PlaybackState): void {
    if (this._state !== newState) {
      this._state = newState;
      for (const obs of this.observers) {
        obs.onStateChange(newState);
      }
    }
  }

  private notifyTrackChange(): void {
    for (const obs of this.observers) {
      obs.onTrackChange(this.currentTrack);
    }
  }

  private notifyVolumeChange(): void {
    for (const obs of this.observers) {
      obs.onVolumeChange(this._volume);
    }
  }

  // ─── Progress Updates ───────────────────────────────────────

  private startProgressUpdates(): void {
    this.stopProgressUpdates();
    this.progressInterval = setInterval(() => {
      if (!this.audioOutput || this._state !== PlaybackState.Playing) return;
      if (this._isHandlingTrackEnd) return; // Guard: don't interfere with in-progress transition

      const current = this.getCurrentTime();
      const total = this.getDuration();
      for (const obs of this.observers) {
        obs.onProgressChange(current, total);
      }

      // Auto-advance on track end.
      if (total > 0 && current >= total - 0.5) {
        this.handleTrackEnd();
        return;
      }

      // Fallback: check Rust sink state every 2 ticks (~500ms).
      // If the audio sink is empty but we think we're playing, the track ended.
      if (Math.round(current * 2) % 2 === 0) {
        this.checkSinkEnded();
      }

      // Every 4th tick (~1s): verify the Rust audio sink is actually making
      // progress. After OS sleep the WASAPI stream can die silently — the
      // client-side clock keeps advancing (progress bar moves) but no sound
      // comes out. Rebuild the sink at the current position to recover.
      this.stallCheckTick += 1;
      if (this.stallCheckTick % 4 === 0) {
        this.checkSinkStalled();
      }
    }, 250);
  }

  private stopProgressUpdates(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  /**
   * Polls the Rust audio backend to detect if the sink has drained.
   * If so, triggers auto-advance — catches cases where client-side
   * duration tracking can't determine the track length.
   */
  private async checkSinkEnded(): Promise<void> {
    if (this._isHandlingTrackEnd) return; // Guard: already transitioning
    try {
      const empty = await invoke<boolean>("is_audio_sink_empty");
      if (empty && this._state === PlaybackState.Playing && !this._isHandlingTrackEnd) {
        const current = this.audioOutput?.getCurrentTime() ?? 0;
        // Only advance if we've played at least 1 second (avoid false triggers).
        if (current > 1.0) {
          this.handleTrackEnd();
        }
      }
    } catch {
      // Non-critical: if the command isn't available, fall through.
    }
  }

  /**
   * Polls the Rust audio backend for the sink's real playback position.
   * If the client-side clock advances while the sink makes no progress,
   * the audio device is stalled (typical after sleep/resume) — rebuild the
   * sink at the current position so sound resumes.
   */
  private async checkSinkStalled(): Promise<void> {
    if (this._isHandlingTrackEnd || this._state !== PlaybackState.Playing) return;
    const trackIdAtCheck = this.currentTrack?.id;
    const versionAtCheck = this.seekVersion;
    try {
      const rustPos = await invoke<number>("get_audio_position");
      // Guard: a track change / seek may have happened while the IPC was
      // in flight — never act on stale state.
      if (
        this.seekVersion !== versionAtCheck ||
        this.currentTrack?.id !== trackIdAtCheck ||
        this._state !== PlaybackState.Playing
      ) {
        return;
      }
      const clientPos = this.getCurrentTime();

      if (this.lastRustPos >= 0) {
        const clientAdvanced = clientPos - this.lastClientPosAtRust;
        const rustAdvanced = rustPos - this.lastRustPos;
        if (clientPos > 2.0 && clientAdvanced >= 0.4 && rustAdvanced < 0.05) {
          console.warn(
            "[PlaybackEngine] Audio sink stalled (client advanced " +
              clientAdvanced.toFixed(2) + "s, sink advanced " + rustAdvanced.toFixed(2) +
              "s). Rebuilding at " + clientPos.toFixed(1) + "s."
          );
          // Reset baseline so we don't immediately re-trigger.
          this.lastRustPos = -1.0;
          await this.seek(clientPos);
          return;
        }
      }
      this.lastRustPos = rustPos;
      this.lastClientPosAtRust = clientPos;
    } catch {
      // Command unavailable (e.g. web build) — non-critical.
    }
  }

  /** Forget the stall-detection baseline (called after any sink rebuild). */
  private resetStallBaseline(): void {
    this.seekVersion += 1;
    this.lastRustPos = -1.0;
    this.lastClientPosAtRust = 0.0;
  }

  /**
   * Handles end-of-track logic. Stops progress updates immediately to
   * prevent re-entry, then branches on repeat mode:
   *  - Track: seeks back to 0 and resumes progress updates.
   *  - Playlist/Off: advances to the next track (which restarts updates).
   */
  private async handleTrackEnd(): Promise<void> {
    if (this._isHandlingTrackEnd) return;
    this._isHandlingTrackEnd = true;
    this.stopProgressUpdates();

    try {
      if (this._repeatMode === RepeatMode.Track) {
        await this.seek(0);
        if (this._state === PlaybackState.Playing) {
          this.startProgressUpdates();
          this.syncDiscordPresence(true);
        }
      } else {
        await this.next();
      }
    } finally {
      this._isHandlingTrackEnd = false;
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────

  /**
   * Sync the current playback state to Discord Rich Presence.
   */
  private syncDiscordPresence(isPlaying: boolean): void {
    const track = this.currentTrack;
    const rpc = DiscordRpcService.getInstance();

    if (!track || this._state === PlaybackState.Stopped || this._state === PlaybackState.Idle) {
      rpc.clearPresence();
      return;
    }

    const pos = this.getCurrentTime();
    const dur = this.getDuration();
    console.log("[DiscordRpc] syncPresence:", { title: track.title, isPlaying, pos: pos.toFixed(1), dur: dur.toFixed(1) });

    rpc.updatePresence({
      title: track.title,
      artist: track.artist,
      album: track.album,
      isPlaying,
      positionSecs: pos,
      durationSecs: dur,
    });
  }

  destroy(): void {
    this.stopProgressUpdates();
    this.audioOutput?.stop();
    this.observers.clear();
    this.queue = [];
    this.currentIndex = -1;
    this._state = PlaybackState.Idle;
  }
}
