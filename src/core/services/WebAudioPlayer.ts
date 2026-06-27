import { IAudioOutput } from "@core/interfaces";

/**
 * WebAudioPlayer — implements IAudioOutput using the Web Audio API.
 *
 * Replaces NativeAudioPlayer for the web/PWA build. Uses AudioContext
 * for decoding and playback. Duration comes from the decoded AudioBuffer.
 * Seek is done by creating a new source node at the target offset.
 *
 * Design Pattern: Strategy (implements IAudioOutput)
 */
export class WebAudioPlayer implements IAudioOutput {
  private _ctx: AudioContext | null = null;
  private _gainNode: GainNode | null = null;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _buffer: AudioBuffer | null = null;

  private _playing = false;
  private _paused = false;
  private _volume = 1.0;
  private _rate = 1.0;

  /** When the current source started playing (AudioContext.currentTime). */
  private _startedAt = 0;
  /** Offset within the buffer where this source started (seconds). */
  private _startOffset = 0;
  /** Cached duration from the decoded AudioBuffer. */
  private _duration = 0;
  /** Buffer source of the audio, stored for URL-based playback. */
  // @ts-ignore: reserved for future URL caching
  private _audioUrl: string | null = null;

  // ── Lazy AudioContext (must be created after user gesture) ──

  private get ctx(): AudioContext {
    if (!this._ctx) {
      this._ctx = new AudioContext();
      this._gainNode = this._ctx.createGain();
      this._gainNode.gain.value = this._volume;
      this._gainNode.connect(this._ctx.destination);
    }
    return this._ctx;
  }

  private get gain(): GainNode {
    if (!this._gainNode) {
      // Ensure ctx is initialized first
      void this.ctx;
    }
    return this._gainNode!;
  }

  // ─── IAudioOutput ──────────────────────────────────

  async play(filePathOrUrl: string): Promise<void> {
    this.stop();

    try {
      // Fetch the audio file and decode it.
      const response = await fetch(filePathOrUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

      this._buffer = audioBuffer;
      this._duration = audioBuffer.duration;
      this._audioUrl = filePathOrUrl;
      this._startOffset = 0;
      this._playing = true;
      this._paused = false;

      this._createSource(0);
      this._startedAt = this.ctx.currentTime;
      this._sourceNode!.start(0, 0);
    } catch (e) {
      console.error("[WebAudioPlayer] Play failed:", e);
      this._playing = false;
      throw e;
    }
  }

  pause(): void {
    if (!this._playing || this._paused) return;
    this._paused = true;
    // Record how far we've played.
    this._startOffset += this.ctx.currentTime - this._startedAt;
    this._stopSource();
  }

  resume(): void {
    if (!this._playing || !this._paused) return;
    if (!this._buffer) return;

    this._paused = false;
    this._createSource(this._startOffset);
    this._startedAt = this.ctx.currentTime;
    this._sourceNode!.start(0, this._startOffset);
  }

  stop(): void {
    this._playing = false;
    this._paused = false;
    this._startOffset = 0;
    this._startedAt = 0;
    this._duration = 0;
    this._buffer = null;
    this._audioUrl = null;
    this._stopSource();
  }

  async seek(seconds: number): Promise<void> {
    const s = Math.max(0, Math.min(seconds, this._duration));
    this._startOffset = s;

    if (this._playing && !this._paused && this._buffer) {
      // Recreate source at new offset.
      this._stopSource();
      this._createSource(s);
      this._startedAt = this.ctx.currentTime;
      this._sourceNode!.start(0, s);
    }
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._gainNode) {
      this._gainNode.gain.value = this._volume;
    }
  }

  setPlaybackRate(rate: number): void {
    this._rate = Math.max(0.25, Math.min(4, rate));
    if (this._sourceNode) {
      this._sourceNode.playbackRate.value = this._rate;
    }
  }

  getPlaybackRate(): number {
    return this._rate;
  }

  getCurrentTime(): number {
    if (this._playing && !this._paused) {
      const elapsed = this.ctx.currentTime - this._startedAt;
      return Math.min(this._startOffset + elapsed, this._duration);
    }
    return this._startOffset;
  }

  getDuration(): number {
    return this._duration;
  }

  getVolume(): number {
    return this._volume;
  }

  isPlaying(): boolean {
    return this._playing && !this._paused;
  }

  // ─── Private Helpers ───────────────────────────────

  private _createSource(_offset: number): void {
    if (!this._buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.gain);
    src.onended = () => {
      // Only trigger if this source is still the current one.
      if (this._sourceNode === src && this._playing && !this._paused) {
        const endTime = this._startOffset + (this.ctx.currentTime - this._startedAt);
        if (endTime >= this._duration - 0.1) {
          // Track ended naturally — let PlaybackEngine handle it.
          this._playing = false;
          this._startOffset = this._duration;
        }
      }
    };
    this._sourceNode = src;
  }

  private _stopSource(): void {
    if (this._sourceNode) {
      try {
        this._sourceNode.onended = null;
        this._sourceNode.stop(0);
      } catch {
        // Already stopped — ignore.
      }
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }
  }

  /** Suspend the AudioContext when not needed (saves battery on mobile). */
  async suspendContext(): Promise<void> {
    if (this._ctx && this._ctx.state === "running" && !this._playing) {
      await this._ctx.suspend();
    }
  }
}
