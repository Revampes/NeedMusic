import { listen } from "@tauri-apps/api/event";
import { PlaybackEngine, PlaybackState } from "@core/services/PlaybackEngine";

export interface MediaActionPayload {
  play?: boolean;
  pause?: boolean;
  playPause?: boolean;
  next?: boolean;
  previous?: boolean;
  stop?: boolean;
}

/**
 * MediaControlBridge — listens for media-action events from the Rust backend
 * (global shortcuts + system tray) and routes them to the PlaybackEngine.
 *
 * Design Pattern: Singleton
 */
export class MediaControlBridge {
  private static instance: MediaControlBridge | null = null;
  private unlisten: (() => void) | null = null;
  private engine: PlaybackEngine;

  private constructor() {
    this.engine = PlaybackEngine.getInstance();
  }

  static getInstance(): MediaControlBridge {
    if (!MediaControlBridge.instance) {
      MediaControlBridge.instance = new MediaControlBridge();
    }
    return MediaControlBridge.instance;
  }

  async start(): Promise<void> {
    this.unlisten = await listen<MediaActionPayload>(
      "media-action",
      (event) => {
        const payload = event.payload;
        if (payload.playPause || payload.play || payload.pause) {
          this.handlePlayPause();
        }
        if (payload.next) {
          this.engine.next();
        }
        if (payload.previous) {
          this.engine.previous();
        }
        if (payload.stop) {
          this.engine.stop();
        }
      }
    );
  }

  private handlePlayPause(): void {
    switch (this.engine.state) {
      case PlaybackState.Playing:
        this.engine.pause();
        break;
      case PlaybackState.Paused:
        this.engine.resume();
        break;
      default:
        // If idle, there's nothing to play/pause.
        break;
    }
  }

  destroy(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}
