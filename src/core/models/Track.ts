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
  public readonly title: string;
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
    this.dateAdded = new Date();
    this.isFavorite = false;
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
