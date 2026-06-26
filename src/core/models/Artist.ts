import { Track } from "./Track";
import { Album } from "./Album";

/**
 * Strongly-typed Artist entity that groups tracks, albums, and provides
 * artist-level metadata.
 */
export class Artist {
  public readonly name: string;
  public readonly tracks: Track[];
  public readonly albums: Album[];

  constructor(name: string, tracks: Track[] = [], albums: Album[] = []) {
    this.name = name;
    this.tracks = tracks;
    this.albums = albums;
  }

  // ─── Accessors ──────────────────────────────────────────────

  get trackCount(): number {
    return this.tracks.length;
  }

  get albumCount(): number {
    return this.albums.length;
  }

  get totalDurationSecs(): number {
    return this.tracks.reduce((sum, t) => sum + t.durationSecs, 0);
  }

  get genres(): string[] {
    const genreSet = new Set(this.tracks.map((t) => t.genre).filter(Boolean));
    return [...genreSet];
  }

  get yearsActive(): string {
    const years = this.tracks
      .map((t) => t.year)
      .filter((y): y is number => y !== null)
      .sort((a, b) => a - b);
    if (years.length === 0) return "";
    const min = years[0];
    const max = years[years.length - 1];
    if (min === max) return `${min}`;
    return `${min}–${max}`;
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
   * Groups tracks into Artist entities.
   */
  static groupByArtist(tracks: Track[]): Map<string, Artist> {
    const artistMap = new Map<string, Artist>();
    const albumMap = Album.groupByAlbum(tracks);

    for (const track of tracks) {
      if (!artistMap.has(track.artist)) {
        artistMap.set(track.artist, new Artist(track.artist));
      }
      artistMap.get(track.artist)!.tracks.push(track);
    }

    // Link albums to artists.
    for (const [, album] of albumMap) {
      const artist = artistMap.get(album.artist);
      if (artist) {
        artist.albums.push(album);
      }
    }

    return artistMap;
  }
}
