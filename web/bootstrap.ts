/**
 * Web bootstrap — initializes the web version of NeedMusic
 * without any Tauri dependencies.
 */

import { PlaybackEngine, PlaybackState, RepeatMode } from "@core/services/PlaybackEngine";
import { WebAudioPlayer } from "@core/services/WebAudioPlayer";

export { PlaybackEngine, PlaybackState, RepeatMode };

/**
 * Simple in-memory track store for the web version.
 * In production this would use IndexedDB.
 */
class WebTrackStore {
  private tracks: TrackData[] = [];

  addTrack(t: TrackData): void {
    if (!this.tracks.find((x) => x.id === t.id)) {
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
 */
export function initWebPlayer(): PlaybackEngine {
  const engine = PlaybackEngine.resetInstance
    ? (PlaybackEngine.resetInstance(), PlaybackEngine.getInstance())
    : PlaybackEngine.getInstance();
  engine.setAudioOutput(new WebAudioPlayer());
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
