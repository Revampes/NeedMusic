import { IAudioOutput } from "@core/interfaces";

/**
 * HtmlAudioPlayer — implements IAudioOutput using native media elements.
 *
 * This is the primary player for the web/mobile build. It streams
 * progressively (HTTP Range) instead of downloading whole files, which is
 * what iOS Safari needs.
 *
 * MP4 handling: iOS Safari's <audio> element refuses MP4 containers that
 * contain a video track (and is picky about audio/mp4 in general). Chrome
 * tolerates them; Safari does not. So for MP4-family sources (.mp4/.m4a) we
 * play through a hidden <video> element, which handles any MP4 container
 * (video or pure-audio) on iOS. All other formats use <audio>.
 *
 * Design Pattern: Strategy (implements IAudioOutput)
 */
export class HtmlAudioPlayer implements IAudioOutput {
  private audio: HTMLAudioElement;
  private video: HTMLVideoElement;
  /** The element currently in use (audio or video). */
  private el: HTMLMediaElement;
  private _volume = 1.0;
  private _rate = 1.0;
  /** Resolve/reject of the in-flight play() promise, if any. */
  private playResolve: (() => void) | null = null;
  private playReject: ((e: Error) => void) | null = null;
  private loadStarted = false;
  /** Set once a source has fallen back from <audio> to <video>. */
  private usedVideoFallback = false;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.volume = this._volume;
    this.audio.playbackRate = this._rate;

    this.video = document.createElement("video");
    this.video.preload = "auto";
    this.video.volume = this._volume;
    this.video.playbackRate = this._rate;
    this.video.playsInline = true; // iOS: no fullscreen
    this.video.muted = false;
    this.video.style.display = "none";
    this.video.setAttribute("playsinline", "");

    this.el = this.audio;
  }

  /** True for MP4-family sources, which need the <video> element on iOS. */
  private isMp4Family(url: string): boolean {
    const path = url.split("?")[0].split("#")[0].toLowerCase();
    return path.endsWith(".mp4") || path.endsWith(".m4a") || path.endsWith(".m4b");
  }

  private currentElement(): HTMLMediaElement {
    return this.el;
  }

  async play(filePathOrUrl: string): Promise<void> {
    this.stop();
    this.usedVideoFallback = false;

    const useVideo = this.isMp4Family(filePathOrUrl);
    this.el = useVideo ? this.video : this.audio;

    return new Promise<void>((resolve, reject) => {
      this.playResolve = resolve;
      this.playReject = reject;
      this.loadStarted = true;

      const el = this.currentElement();
      const onCanPlay = () => {
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("error", onError);
        const resolvePlay = this.playResolve;
        this.playResolve = null;
        this.playReject = null;
        resolvePlay?.();
      };
      const onError = () => {
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("error", onError);
        const msg = el.error?.message || "Load failed";

        // <audio> failed on an MP4 — retry once through <video> (iOS won't
        // play MP4 video tracks in an audio element).
        if (el === this.audio && useVideo && !this.usedVideoFallback) {
          this.usedVideoFallback = true;
          this.el = this.video;
          const v = this.video;
          const retryCanPlay = () => {
            v.removeEventListener("canplay", retryCanPlay);
            v.removeEventListener("error", retryError);
            const resolvePlay = this.playResolve;
            this.playResolve = null;
            this.playReject = null;
            resolvePlay?.();
          };
          const retryError = () => {
            v.removeEventListener("canplay", retryCanPlay);
            v.removeEventListener("error", retryError);
            this.playReject?.(new Error(v.error?.message || msg));
            this.playReject = null;
            this.playResolve = null;
          };
          v.addEventListener("canplay", retryCanPlay);
          v.addEventListener("error", retryError);
          v.src = filePathOrUrl;
          v.volume = this._volume;
          v.playbackRate = this._rate;
          v.play().catch(() => { /* error event will fire */ });
          return;
        }

        this.playReject?.(new Error(msg));
        this.playReject = null;
        this.playResolve = null;
      };

      el.addEventListener("canplay", onCanPlay);
      el.addEventListener("error", onError);

      el.src = filePathOrUrl;
      el.volume = this._volume;
      el.playbackRate = this._rate;
      el.play().catch((e) => {
        // Autoplay-policy rejection — the error event usually fires too.
        if (!this.playResolve) return;
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("error", onError);
        this.playReject?.(e instanceof Error ? e : new Error(String(e)));
        this.playReject = null;
        this.playResolve = null;
      });
    });
  }

  pause(): void {
    this.currentElement().pause();
  }

  resume(): void {
    this.currentElement().play().catch(() => { /* keep paused; surfaces on next play */ });
  }

  stop(): void {
    const el = this.currentElement();
    el.pause();
    try {
      el.removeAttribute("src");
      el.load(); // release the network connection
    } catch { /* ignore */ }
    this.playResolve = null;
    this.playReject = null;
    this.loadStarted = false;
  }

  async seek(seconds: number): Promise<void> {
    try {
      this.currentElement().currentTime = Math.max(0, seconds);
    } catch { /* not seekable yet — ignore */ }
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    this.audio.volume = this._volume;
    this.video.volume = this._volume;
  }

  setPlaybackRate(rate: number): void {
    this._rate = Math.max(0.25, Math.min(4, rate));
    this.audio.playbackRate = this._rate;
    this.video.playbackRate = this._rate;
  }

  getPlaybackRate(): number {
    return this._rate;
  }

  getCurrentTime(): number {
    const t = this.currentElement().currentTime;
    return this.loadStarted && Number.isFinite(t) ? t : 0;
  }

  getDuration(): number {
    const d = this.currentElement().duration;
    return Number.isFinite(d) ? d : 0;
  }

  getVolume(): number {
    return this._volume;
  }

  isPlaying(): boolean {
    const el = this.currentElement();
    return !el.paused && !el.ended && this.loadStarted;
  }
}
