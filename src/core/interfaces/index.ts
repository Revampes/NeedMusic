/// Unique identifier for a Track within the library.
export type TrackId = string;

/// Supported audio codec types.
export enum AudioCodec {
  MP3 = "mp3",
  FLAC = "flac",
  M4A = "m4a",
  AAC = "aac",
  OGG = "ogg",
  OPUS = "opus",
  WAV = "wav",
  WMA = "wma",
  AIFF = "aiff",
  Unknown = "unknown",
}

/// Audio playback states for the PlaybackEngine.
export enum PlaybackState {
  Idle = "idle",
  Playing = "playing",
  Paused = "paused",
  Stopped = "stopped",
}

/// Repeat mode for playback.
export enum RepeatMode {
  Off = "off",
  Track = "track",
  Playlist = "playlist",
}

/// Sort order for playlists.
export enum SortOrder {
  Title = "title",
  Artist = "artist",
  Album = "album",
  DateAdded = "dateAdded",
  Duration = "duration",
  Year = "year",
}

/// Observer interface for the Observer pattern.
/// Components implement this to react to engine state changes.
export interface IPlaybackObserver {
  onStateChange(state: PlaybackState): void;
  onTrackChange(track: ITrack | null): void;
  onProgressChange(currentSecs: number, totalSecs: number): void;
  onVolumeChange(volume: number): void;
}

/// Observer interface for library changes.
export interface ILibraryObserver {
  onLibraryUpdated(tracks: ITrack[]): void;
  onScanProgress(progress: number, currentDir: string): void;
  onScanComplete(trackCount: number): void;
}

/// Core Track interface — all track types must implement this.
export interface ITrack {
  readonly id: TrackId;
  readonly filePath: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly albumArtist: string;
  readonly durationSecs: number;
  readonly trackNumber: number | null;
  readonly discNumber: number | null;
  readonly genre: string;
  readonly year: number | null;
  readonly codec: AudioCodec;
  readonly hasArtwork: boolean;
  readonly dateAdded: Date;
  /** Whether this track is favorited. */
  isFavorite: boolean;

  formatDuration(): string;
  displayArtist(): string;
  /** Audio metadata string like "FLAC 48000Hz 16bit 1138kbps". */
  audioMetadata(): string;
}

/// Full player state for UI rendering.
export interface PlayerState {
  currentTrack: ITrack | null;
  playbackState: PlaybackState;
  currentTimeSecs: number;
  durationSecs: number;
  volume: number;
  playbackRate: number;
  repeatMode: RepeatMode;
  isShuffled: boolean;
  isFavorite: boolean;
  buffering: boolean;
}

/// Core Playlist interface.
export interface IPlaylist {
  readonly id: string;
  readonly name: string;
  readonly tracks: ITrack[];
  readonly trackCount: number;
  readonly totalDurationSecs: number;

  addTrack(track: ITrack): void;
  removeTrack(trackId: TrackId): void;
  shuffle(): void;
  sort(order: SortOrder): void;
  getTrack(index: number): ITrack | null;
  indexOf(trackId: TrackId): number;

  /** Format total duration as a string. */
  formatTotalDuration(): string;
}

/// Audio output abstraction (Strategy pattern).
export interface IAudioOutput {
  play(filePath: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getVolume(): number;
  isPlaying(): boolean;
}
