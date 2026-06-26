import {
  IPlaylist,
  ITrack,
  TrackId,
  SortOrder,
} from "@core/interfaces";

/**
 * Domain model representing a playlist — a named, ordered collection of Tracks.
 * Supports shuffling, sorting, and sequence management.
 */
export class Playlist implements IPlaylist {
  public readonly id: string;
  public readonly name: string;
  private _tracks: ITrack[];

  constructor(id: string, name: string, tracks: ITrack[] = []) {
    this.id = id;
    this.name = name;
    this._tracks = [...tracks];
  }

  // ─── Accessors ──────────────────────────────────────────────

  get tracks(): ITrack[] {
    return [...this._tracks];
  }

  get trackCount(): number {
    return this._tracks.length;
  }

  get totalDurationSecs(): number {
    return this._tracks.reduce((sum, t) => sum + t.durationSecs, 0);
  }

  // ─── Mutation Methods ───────────────────────────────────────

  addTrack(track: ITrack): void {
    this._tracks.push(track);
  }

  removeTrack(trackId: TrackId): void {
    this._tracks = this._tracks.filter((t) => t.id !== trackId);
  }

  shuffle(): void {
    // Fisher-Yates shuffle.
    const arr = this._tracks;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  sort(order: SortOrder): void {
    switch (order) {
      case SortOrder.Title:
        this._tracks.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case SortOrder.Artist:
        this._tracks.sort((a, b) => a.artist.localeCompare(b.artist));
        break;
      case SortOrder.Album:
        this._tracks.sort((a, b) => a.album.localeCompare(b.album));
        break;
      case SortOrder.DateAdded:
        this._tracks.sort(
          (a, b) => a.dateAdded.getTime() - b.dateAdded.getTime()
        );
        break;
      case SortOrder.Duration:
        this._tracks.sort((a, b) => a.durationSecs - b.durationSecs);
        break;
      case SortOrder.Year:
        this._tracks.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
        break;
    }
  }

  // ─── Query Methods ──────────────────────────────────────────

  getTrack(index: number): ITrack | null {
    if (index < 0 || index >= this._tracks.length) return null;
    return this._tracks[index];
  }

  indexOf(trackId: TrackId): number {
    return this._tracks.findIndex((t) => t.id === trackId);
  }

  // ─── Display ────────────────────────────────────────────────

  formatTotalDuration(): string {
    const total = this.totalDurationSecs;
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    return `${mins}m`;
  }

  /**
   * Creates a shallow copy of this playlist with a new name.
   */
  clone(newName?: string): Playlist {
    return new Playlist(
      `${this.id}_copy_${Date.now()}`,
      newName ?? `${this.name} (Copy)`,
      this._tracks
    );
  }
}
