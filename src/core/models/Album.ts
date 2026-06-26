import { Track } from "./Track";

/**
 * Strongly-typed Album entity that groups tracks and provides album-level
 * metadata and operations.
 */
export class Album {
  public readonly title: string;
  public readonly artist: string;
  public readonly year: number | null;
  public readonly tracks: Track[];
  public readonly artworkPath: string | null;

  constructor(
    title: string,
    artist: string,
    year: number | null = null,
    tracks: Track[] = [],
    artworkPath: string | null = null
  ) {
    this.title = title;
    this.artist = artist;
    this.year = year;
    this.tracks = tracks;
    this.artworkPath = artworkPath;
  }

  // ─── Accessors ──────────────────────────────────────────────

  get trackCount(): number {
    return this.tracks.length;
  }

  get totalDurationSecs(): number {
    return this.tracks.reduce((sum, t) => sum + t.durationSecs, 0);
  }

  get genres(): string[] {
    const genreSet = new Set(this.tracks.map((t) => t.genre).filter(Boolean));
    return [...genreSet];
  }

  // ─── Queries ────────────────────────────────────────────────

  /**
   * Returns tracks sorted by disc and track number.
   */
  getTracksInOrder(): Track[] {
    return [...this.tracks].sort((a, b) => {
      const discA = a.discNumber ?? 1;
      const discB = b.discNumber ?? 1;
      if (discA !== discB) return discA - discB;
      return (a.trackNumber ?? 0) - (b.trackNumber ?? 0);
    });
  }

  formatTotalDuration(): string {
    const total = this.totalDurationSecs;
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  }

  // ─── Factory ────────────────────────────────────────────────

  /**
   * Groups an array of Track objects into Album entities keyed by
   * (album, albumArtist).
   */
  static groupByAlbum(tracks: Track[]): Map<string, Album> {
    const albumMap = new Map<string, Album>();

    for (const track of tracks) {
      const key = `${track.album}||${track.albumArtist}`;
      if (!albumMap.has(key)) {
        albumMap.set(
          key,
          new Album(
            track.album,
            track.albumArtist,
            track.year,
            [],
            null
          )
        );
      }
      albumMap.get(key)!.tracks.push(track);
    }

    return albumMap;
  }
}
