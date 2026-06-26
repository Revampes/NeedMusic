import { IAudioOutput } from "@core/interfaces";
import { invoke } from "@tauri-apps/api/core";

/**
 * NativeAudioPlayer — delegates audio playback to the Rust backend
 * (rodio/symphonia via WASAPI). This ensures the Windows volume mixer
 * shows "NeedMusic" instead of "Microsoft Edge WebView2".
 *
 * Because rodio doesn't expose elapsed position, time is tracked
 * client-side. Duration is read from track metadata (not the audio stream).
 *
 * Design Pattern: Strategy
 */
export class NativeAudioPlayer implements IAudioOutput {
  private _playing = false;
  private _paused = false;
  private _volume = 1.0;
  private _rate = 1.0;
  private _elapsedSecs = 0;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _startedAt = 0; // performance.now() when playback started/resumed
  private _cachedDuration = 0; // cached from Rust decoder on play

  async play(filePath: string): Promise<void> {
    this.stop();
    this._elapsedSecs = 0;
    this._startedAt = performance.now();
    this._playing = true;
    this._paused = false;
    this._cachedDuration = 0;

    await invoke("play_audio", { filePath });
    await invoke("set_audio_volume", { volume: this._volume });

    // Fetch actual duration from rodio's decoder.
    try {
      this._cachedDuration = await invoke<number>("get_audio_duration");
    } catch {
      // Non-critical: fallback to 0.
    }

    this._startTimer();
  }

  pause(): void {
    if (!this._playing || this._paused) return;
    this._paused = true;
    // Freeze elapsed at current position.
    this._elapsedSecs += (performance.now() - this._startedAt) / 1000;
    this._stopTimer();
    invoke("pause_audio").catch(console.error);
  }

  resume(): void {
    if (!this._playing || !this._paused) return;
    this._paused = false;
    this._startedAt = performance.now();
    this._startTimer();
    invoke("resume_audio").catch(console.error);
  }

  stop(): void {
    this._playing = false;
    this._paused = false;
    this._elapsedSecs = 0;
    this._cachedDuration = 0;
    this._stopTimer();
    invoke("stop_audio").catch(console.error);
  }

  async seek(secs: number): Promise<void> {
    const s = Math.max(0, secs);
    this._elapsedSecs = s;
    this._startedAt = performance.now();
    try {
      await invoke("seek_audio", { secs: s });
      // Refresh cached duration from the Rust backend (now returns total duration).
      try {
        this._cachedDuration = await invoke<number>("get_audio_duration");
      } catch {
        // Non-critical.
      }
    } catch (e) {
      console.error("[NativeAudioPlayer] Seek failed:", e);
    }
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    invoke("set_audio_volume", { volume: this._volume }).catch(console.error);
  }

  setPlaybackRate(_rate: number): void {
    this._rate = Math.max(0.25, Math.min(4, _rate));
    // rodio/symphonia doesn't support rate changes.
  }

  getPlaybackRate(): number {
    return this._rate;
  }

  getCurrentTime(): number {
    if (this._playing && !this._paused) {
      return this._elapsedSecs + (performance.now() - this._startedAt) / 1000;
    }
    return this._elapsedSecs;
  }

  getDuration(): number {
    return this._cachedDuration;
  }

  getVolume(): number {
    return this._volume;
  }

  isPlaying(): boolean {
    return this._playing && !this._paused;
  }

  // ── private ──────────────────────────────────────

  private _startTimer(): void {
    this._stopTimer();
    this._timer = setInterval(() => {
      // Timer just keeps us alive; actual time is computed from performance.now()
    }, 250);
  }

  private _stopTimer(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
