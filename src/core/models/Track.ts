import {
  ITrack,
  TrackId,
  AudioCodec,
} from "@core/interfaces";

/**
 * Domain model representing an audio track.
 * Encapsulates all metadata and provides display formatting methods.
 */
export class Track implements ITrack {
  public readonly id: TrackId;
  public readonly filePath: string;
  public title: string;
  public readonly artist: string;
  public readonly album: string;
  public readonly albumArtist: string;
  public readonly durationSecs: number;
  public readonly trackNumber: number | null;
  public readonly discNumber: number | null;
  public readonly genre: string;
  public readonly year: number | null;
  public readonly codec: AudioCodec;
  public readonly hasArtwork: boolean;
  public readonly dateAdded: Date;
  public isFavorite: boolean;
  /** Star rating 0–5 (0 = unrated). Synced cross-device via LWW. */
  public rating: number;
  /** Last playback position in seconds (for cross-device resume). */
  public resumePositionSecs: number;

  constructor(params: {
    filePath: string;
    title: string;
    artist: string;
    album: string;
    albumArtist: string;
    durationSecs: number;
    trackNumber?: number | null;
    discNumber?: number | null;
    genre?: string;
    year?: number | null;
    codec?: AudioCodec;
    hasArtwork?: boolean;
    isFavorite?: boolean;
    rating?: number;
    resumePositionSecs?: number;
    /** When the track entered the library. Defaults to now (new imports). */
    dateAdded?: Date;
  }) {
    this.id = Track.generateId(params.filePath);
    this.filePath = params.filePath;
    this.title = params.title || "Unknown";
    this.artist = params.artist || "Unknown Artist";
    this.album = params.album || "Unknown Album";
    this.albumArtist = params.albumArtist || params.artist || "Unknown Artist";
    this.durationSecs = params.durationSecs || 0;
    this.trackNumber = params.trackNumber ?? null;
    this.discNumber = params.discNumber ?? null;
    this.genre = params.genre || "";
    this.year = params.year ?? null;
    this.codec = params.codec ?? Track.detectCodec(params.filePath);
    this.hasArtwork = params.hasArtwork ?? false;
    this.dateAdded = params.dateAdded ?? new Date();
    this.isFavorite = params.isFavorite ?? false;
    this.rating = Track.clampRating(params.rating);
    this.resumePositionSecs = Number(params.resumePositionSecs) > 0 ? Number(params.resumePositionSecs) : 0;
  }

  /** Clamp a rating into the valid 0–5 integer range. */
  static clampRating(value: unknown): number {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(5, n);
  }

  /**
   * Parse a SQLite timestamp into a Date.
   * `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in **UTC** with no zone
   * marker, which `new Date()` would otherwise read as local time — so the
   * string is normalized to ISO (UTC) first.
   */
  static parseDbDate(value: string | null | undefined): Date | undefined {
    if (!value) return undefined;
    const s = String(value).trim();
    if (!s) return undefined;
    const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)
      ? `${s.replace(" ", "T")}Z`
      : s;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  // ─── Factory Methods ───────────────────────────────────────

  /**
   * Creates a Track from raw Tauri backend metadata.
   */
  static fromBackendMetadata(raw: {
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
    is_favorite?: number | boolean | string;
    rating?: number | string | null;
    resume_position_secs?: number | string | null;
    date_added?: string | null;
  }): Track {
    return new Track({
      filePath: raw.file_path,
      title: raw.title,
      artist: raw.artist,
      album: raw.album,
      albumArtist: raw.album_artist,
      durationSecs: raw.duration_secs,
      trackNumber: raw.track_number,
      discNumber: raw.disc_number,
      genre: raw.genre,
      year: raw.year,
      hasArtwork: raw.has_artwork,
      // Normalize SQLite INTEGER (0/1) or boolean representation.
      isFavorite: raw.is_favorite === 1 || raw.is_favorite === "1" || raw.is_favorite === true,
      rating: Track.clampRating(raw.rating),
      resumePositionSecs: Number(raw.resume_position_secs) || 0,
      dateAdded: Track.parseDbDate(raw.date_added),
    });
  }

  // ─── Utility ───────────────────────────────────────────────

  /**
   * Generates a deterministic Track ID from the file path.
   */
  static generateId(filePath: string): TrackId {
    // Simple hash of the file path.
    let hash = 0;
    for (let i = 0; i < filePath.length; i++) {
      const char = filePath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer.
    }
    return `track_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Detects the audio codec from a file extension.
   */
  static detectCodec(filePath: string): AudioCodec {
    const ext = filePath.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "mp3": return AudioCodec.MP3;
      case "flac": return AudioCodec.FLAC;
      case "m4a": return AudioCodec.M4A;
      case "aac": return AudioCodec.AAC;
      case "ogg": return AudioCodec.OGG;
      case "opus": return AudioCodec.OPUS;
      case "wav": return AudioCodec.WAV;
      case "wma": return AudioCodec.WMA;
      case "aiff": return AudioCodec.AIFF;
      default: return AudioCodec.Unknown;
    }
  }

  // ─── Display Formatting ────────────────────────────────────

  formatDuration(): string {
    if (this.durationSecs <= 0) return "0:00";
    const mins = Math.floor(this.durationSecs / 60);
    const secs = Math.floor(this.durationSecs % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  displayArtist(): string {
    if (this.albumArtist && this.albumArtist !== this.artist) {
      return `${this.artist} (${this.albumArtist})`;
    }
    return this.artist;
  }

  /**
   * Virtual path prefix used for online tracks saved WITHOUT downloading.
   * Playing such a track resolves the stream via the source's API and uses
   * the temp cache — the file is never written into the music library.
   */
  static readonly ONLINE_BILIBILI_PREFIX = "bilibili://";
  static readonly ONLINE_YOUTUBE_PREFIX = "youtube://";

  /** Returns "bilibili" | "youtube" | null for online (not downloaded) tracks. */
  get onlineSource(): "bilibili" | "youtube" | null {
    if (this.filePath.startsWith(Track.ONLINE_BILIBILI_PREFIX)) return "bilibili";
    if (this.filePath.startsWith(Track.ONLINE_YOUTUBE_PREFIX)) return "youtube";
    return null;
  }

  /** True when this track was saved to the library without downloading audio. */
  isOnlineTrack(): boolean {
    return this.onlineSource !== null;
  }

  /**
   * Returns a formatted track number string (e.g., "03").
   */
  formatTrackNumber(): string {
    if (this.trackNumber === null) return "";
    return this.trackNumber.toString().padStart(2, "0");
  }

  /**
   * Returns an audio metadata string like "FLAC 48000Hz 16bit 1138kbps".
   * Note: sample rate/bit depth/bitrate aren't stored yet — shows codec only
   * until the Rust scanner is extended to extract stream info.
   */
  audioMetadata(): string {
    const labels: Record<string, string> = {
      mp3: "MP3", flac: "FLAC", m4a: "M4A", aac: "AAC",
      ogg: "OGG", opus: "Opus", wav: "WAV", wma: "WMA", aiff: "AIFF",
    };
    return labels[this.codec] ?? this.codec.toUpperCase();
  }
}
