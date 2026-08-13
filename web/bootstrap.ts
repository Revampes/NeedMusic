/**
 * Web bootstrap — initializes the web version of NeedMusic
 * without any Tauri dependencies.
 */

import { PlaybackEngine, PlaybackState, RepeatMode } from "@core/services/PlaybackEngine";
import { HtmlAudioPlayer } from "@core/services/HtmlAudioPlayer";

export { PlaybackEngine, PlaybackState, RepeatMode };

/**
 * Simple in-memory track store for the web version.
 * In production this would use IndexedDB.
 */
class WebTrackStore {
  private tracks: TrackData[] = [];

  /** Upsert: adds the track, or REPLACES an existing one with the same id
   *  (so re-syncing refreshes audioUrl after the LAN token rotates). */
  addTrack(t: TrackData): void {
    const idx = this.tracks.findIndex((x) => x.id === t.id);
    if (idx >= 0) {
      this.tracks[idx] = t;
    } else {
      this.tracks.push(t);
    }
  }

  addTracks(ts: TrackData[]): void {
    for (const t of ts) this.addTrack(t);
  }

  removeTrack(id: string): void {
    this.tracks = this.tracks.filter((t) => t.id !== id);
  }

  getAll(): TrackData[] {
    return [...this.tracks];
  }

  getById(id: string): TrackData | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  clear(): void {
    this.tracks = [];
  }
}

export interface TrackData {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  durationSecs: number;
  trackNumber: number | null;
  discNumber: number | null;
  genre: string;
  year: number | null;
  codec: string;
  hasArtwork: boolean;
  dateAdded: Date;
  isFavorite: boolean;
  /** The audio source: a blob URL, data URL, or remote URL. */
  audioUrl: string;
  /** Optional artwork data URL. */
  artworkUrl?: string;
  /** Optional file path or source name for display. */
  sourceName?: string;
}

export const webTrackStore = new WebTrackStore();

/**
 * Initialize the web player. Call once at startup.
 *
 * NOTE: do NOT reset the singleton here. The web app grabs the engine via
 * `PlaybackEngine.getInstance()` during render; resetting it here would
 * destroy that instance (leaving it with no audio output) and create a new
 * one that nothing else references — playback would silently do nothing.
 */
export function initWebPlayer(): PlaybackEngine {
  const engine = PlaybackEngine.getInstance();
  engine.setAudioOutput(new HtmlAudioPlayer());
  return engine;
}

/**
 * Convert a TrackData to an ITrack-compatible object for PlaybackEngine.
 */
export function toPlayableTrack(td: TrackData) {
  return {
    id: td.id,
    filePath: td.audioUrl,
    title: td.title,
    artist: td.artist,
    album: td.album,
    albumArtist: td.albumArtist,
    durationSecs: td.durationSecs,
    trackNumber: td.trackNumber,
    discNumber: td.discNumber,
    genre: td.genre,
    year: td.year,
    codec: td.codec as any,
    hasArtwork: td.hasArtwork || !!td.artworkUrl,
    dateAdded: td.dateAdded,
    isFavorite: td.isFavorite,
    formatDuration(): string {
      const m = Math.floor(td.durationSecs / 60);
      const s = Math.floor(td.durationSecs % 60);
      return `${m}:${s.toString().padStart(2, "0")}`;
    },
    displayArtist(): string {
      return td.artist || "Unknown Artist";
    },
    audioMetadata(): string {
      return td.codec?.toUpperCase() ?? "Unknown";
    },
  };
}
