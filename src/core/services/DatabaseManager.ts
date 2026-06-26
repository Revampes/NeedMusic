import Database from "@tauri-apps/plugin-sql";
import { ITrack, TrackId } from "@core/interfaces";
import { Track } from "@core/models/Track";

/**
 * Singleton DatabaseManager — handles all SQLite persistence for the app.
 * Stores track metadata, playlists, and user preferences.
 *
 * Design Pattern: Singleton
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db: Database | null = null;
  private initialized: boolean = false;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  static resetInstance(): void {
    DatabaseManager.instance = null;
  }

  // ─── Initialization ─────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.db = await Database.load("sqlite:needmusic.db");

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS tracks (
        id          TEXT PRIMARY KEY,
        file_path   TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL DEFAULT 'Unknown',
        artist      TEXT NOT NULL DEFAULT 'Unknown Artist',
        album       TEXT NOT NULL DEFAULT 'Unknown Album',
        album_artist TEXT NOT NULL DEFAULT 'Unknown Artist',
        duration_secs REAL NOT NULL DEFAULT 0,
        track_number INTEGER,
        disc_number  INTEGER,
        genre       TEXT DEFAULT '',
        year        INTEGER,
        codec       TEXT DEFAULT 'unknown',
        has_artwork INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        date_added  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS playlists (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL
      );
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL,
        track_id    TEXT NOT NULL,
        position    INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
      );
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.initialized = true;
  }

  // ─── Track CRUD ─────────────────────────────────────────────

  async insertTrack(track: ITrack): Promise<void> {
    await this.ensureDb();
    await this.db!.execute(
      `INSERT OR REPLACE INTO tracks
       (id, file_path, title, artist, album, album_artist,
        duration_secs, track_number, disc_number, genre, year, codec, has_artwork)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        track.id,
        track.filePath,
        track.title,
        track.artist,
        track.album,
        track.albumArtist,
        track.durationSecs,
        track.trackNumber,
        track.discNumber,
        track.genre,
        track.year,
        track.codec,
        track.hasArtwork ? 1 : 0,
      ]
    );
  }

  async insertTracks(tracks: ITrack[]): Promise<void> {
    await this.ensureDb();
    for (const track of tracks) {
      await this.insertTrack(track);
    }
  }

  async getAllTracks(): Promise<Track[]> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      "SELECT * FROM tracks ORDER BY artist, album, track_number"
    );
    return rows.map(Track.fromBackendMetadata);
  }

  async getTrackById(id: TrackId): Promise<Track | null> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      "SELECT * FROM tracks WHERE id = $1",
      [id]
    );
    return rows.length > 0 ? Track.fromBackendMetadata(rows[0]) : null;
  }

  async removeTrack(id: TrackId): Promise<void> {
    await this.ensureDb();
    await this.db!.execute("DELETE FROM tracks WHERE id = $1", [id]);
  }

  async trackExists(filePath: string): Promise<boolean> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      "SELECT 1 FROM tracks WHERE file_path = $1",
      [filePath]
    );
    return rows.length > 0;
  }

  // ─── Favorites ────────────────────────────────────────────

  async setFavorite(trackId: TrackId, fav: boolean): Promise<void> {
    await this.ensureDb();
    await this.db!.execute(
      "UPDATE tracks SET is_favorite = $1 WHERE id = $2",
      [fav ? 1 : 0, trackId]
    );
    // Sync with Favorites playlist.
    const favPlaylistId = "__favorites__";
    if (fav) {
      await this.addTrackToPlaylist(favPlaylistId, trackId);
    } else {
      await this.removeTrackFromPlaylist(favPlaylistId, trackId);
    }
  }

  async getFavorites(): Promise<Track[]> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      "SELECT * FROM tracks WHERE is_favorite = 1 ORDER BY artist, album, track_number"
    );
    return rows.map(Track.fromBackendMetadata);
  }

  // ─── Playlist CRUD ──────────────────────────────────────────

  async createPlaylist(id: string, name: string): Promise<void> {
    await this.ensureDb();
    await this.db!.execute(
      "INSERT INTO playlists (id, name) VALUES ($1, $2)",
      [id, name]
    );
  }

  async getAllPlaylists(): Promise<{ id: string; name: string }[]> {
    await this.ensureDb();
    return await this.db!.select("SELECT id, name FROM playlists");
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.ensureDb();
    await this.db!.execute("DELETE FROM playlists WHERE id = $1", [id]);
  }

  async addTrackToPlaylist(
    playlistId: string,
    trackId: TrackId
  ): Promise<void> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      "SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = $1",
      [playlistId]
    );
    const nextPos = (rows[0]?.max_pos ?? -1) + 1;
    await this.db!.execute(
      "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES ($1, $2, $3)",
      [playlistId, trackId, nextPos]
    );
  }

  async removeTrackFromPlaylist(
    playlistId: string,
    trackId: TrackId
  ): Promise<void> {
    await this.ensureDb();
    await this.db!.execute(
      "DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2",
      [playlistId, trackId]
    );
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      `SELECT t.* FROM tracks t
       JOIN playlist_tracks pt ON t.id = pt.track_id
       WHERE pt.playlist_id = $1
       ORDER BY pt.position`,
      [playlistId]
    );
    return rows.map(Track.fromBackendMetadata);
  }

  // ─── Settings ───────────────────────────────────────────────

  async getSetting(key: string): Promise<string | null> {
    await this.ensureDb();
    const rows: any[] = await this.db!.select(
      "SELECT value FROM settings WHERE key = $1",
      [key]
    );
    return rows.length > 0 ? rows[0].value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.ensureDb();
    await this.db!.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)",
      [key, value]
    );
  }

  // ─── Helpers ────────────────────────────────────────────────

  private async ensureDb(): Promise<void> {
    if (!this.initialized || !this.db) {
      await this.initialize();
    }
  }
}
