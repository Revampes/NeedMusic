import { invoke } from "@tauri-apps/api/core";
import { ILibraryObserver } from "@core/interfaces";
import { Track } from "@core/models/Track";
import { Album } from "@core/models/Album";
import { Artist } from "@core/models/Artist";
import { DatabaseManager } from "./DatabaseManager";

/**
 * Raw metadata returned from the Rust backend.
 */
interface RawTrackMetadata {
  file_path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  duration_secs: number;
  track_number: number | null;
  disc_number: number | null;
  genre: string;
  year: number | null;
  has_artwork: boolean;
}

interface ScanResult {
  tracks: RawTrackMetadata[];
  errors: string[];
}

/**
 * Singleton LibraryManager — orchestrates library scanning, metadata
 * persistence, and in-memory track management.
 *
 * Design Pattern: Singleton + Observer
 */
export class LibraryManager {
  private static instance: LibraryManager | null = null;

  private tracks: Map<string, Track> = new Map();
  private observers: Set<ILibraryObserver> = new Set();
  private dbManager: DatabaseManager;

  private constructor() {
    this.dbManager = DatabaseManager.getInstance();
  }

  static getInstance(): LibraryManager {
    if (!LibraryManager.instance) {
      LibraryManager.instance = new LibraryManager();
    }
    return LibraryManager.instance;
  }

  static resetInstance(): void {
    LibraryManager.instance = null;
  }

  // ─── Observer Management ────────────────────────────────────

  subscribe(observer: ILibraryObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  // ─── Initialization ─────────────────────────────────────────

  /**
   * Load all tracks from the database into memory.
   */
  async initialize(): Promise<void> {
    await this.dbManager.initialize();
    const tracks = await this.dbManager.getAllTracks();
    for (const track of tracks) {
      this.tracks.set(track.id, track);
    }
  }

  // ─── Scanning ───────────────────────────────────────────────

  /**
   * Scans a directory for audio files via the Rust backend,
   * persists new tracks to the database, and notifies observers.
   */
  async scanDirectory(dirPath: string): Promise<number> {
    // Notify start.
    for (const obs of this.observers) {
      obs.onScanProgress(0, dirPath);
    }

    const result: ScanResult = await invoke("scan_directory", {
      path: dirPath,
    });

    if (result.errors.length > 0) {
      console.warn(
        `[LibraryManager] Scan errors (${result.errors.length}):`,
        result.errors.slice(0, 10)
      );
    }

    let newTrackCount = 0;

    for (const raw of result.tracks) {
      const track = Track.fromBackendMetadata(raw);

      // Skip if already in library.
      if (this.tracks.has(track.id)) continue;

      this.tracks.set(track.id, track);
      await this.dbManager.insertTrack(track);
      newTrackCount++;
    }

    // Notify completion.
    for (const obs of this.observers) {
      obs.onScanComplete(newTrackCount);
      obs.onLibraryUpdated(this.getAllTracks());
    }

    return newTrackCount;
  }

  // ─── Queries ────────────────────────────────────────────────

  getAllTracks(): Track[] {
    return [...this.tracks.values()];
  }

  getTrackById(id: string): Track | undefined {
    return this.tracks.get(id);
  }

  /**
   * Returns all albums grouped from the current library.
   */
  getAlbums(): Album[] {
    return [...Album.groupByAlbum(this.getAllTracks()).values()];
  }

  /**
   * Returns all artists grouped from the current library.
   */
  getArtists(): Artist[] {
    return [...Artist.groupByArtist(this.getAllTracks()).values()];
  }

  /**
   * Searches tracks by title, artist, or album (case-insensitive).
   */
  search(query: string): Track[] {
    const lower = query.toLowerCase();
    return this.getAllTracks().filter(
      (t) =>
        t.title.toLowerCase().includes(lower) ||
        t.artist.toLowerCase().includes(lower) ||
        t.album.toLowerCase().includes(lower) ||
        t.genre.toLowerCase().includes(lower)
    );
  }

  /**
   * Add a single track to the library (for downloads, etc.).
   * Persists to DB and notifies observers.
   */
  async addTrack(track: Track): Promise<void> {
    if (this.tracks.has(track.id)) return;
    this.tracks.set(track.id, track);
    await this.dbManager.insertTrack(track);
    for (const obs of this.observers) {
      obs.onLibraryUpdated(this.getAllTracks());
    }
  }

  /**
   * Remove a track from the library.
   * Deletes from DB, in-memory map, and notifies observers.
   */
  async removeTrack(trackId: string): Promise<void> {
    if (!this.tracks.has(trackId)) return;
    this.tracks.delete(trackId);
    await this.dbManager.removeTrack(trackId);
    for (const obs of this.observers) {
      obs.onLibraryUpdated(this.getAllTracks());
    }
  }
}
