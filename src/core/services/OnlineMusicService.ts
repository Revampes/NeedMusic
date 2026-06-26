import { invoke } from "@tauri-apps/api/core";
import { Track } from "@core/models/Track";
import { LibraryManager } from "./LibraryManager";

/**
 * Raw search result from Bilibili (returned by Rust backend).
 */
export interface BilibiliSearchItem {
  bvid: string;
  title: string;
  author: string;
  duration: string;       // "3:45"
  duration_secs: number;
  cover_url: string;
  description: string;
}

export interface OnlineSearchResult {
  results: BilibiliSearchItem[];
  total: number;
}

/**
 * Service for searching and downloading music from Bilibili.
 *
 * Flow:
 *   1. search(query) → BilibiliSearchItem[]
 *   2. downloadAndPlay(bvid) → downloads to temp, returns a Track
 *   3. saveToLibrary(bvid, item) → downloads to music folder, adds to library
 */
export class OnlineMusicService {
  private static instance: OnlineMusicService | null = null;

  static getInstance(): OnlineMusicService {
    if (!OnlineMusicService.instance) {
      OnlineMusicService.instance = new OnlineMusicService();
    }
    return OnlineMusicService.instance;
  }

  /** Search Bilibili for music videos. */
  async search(query: string): Promise<OnlineSearchResult> {
    return await invoke<OnlineSearchResult>("search_bilibili", { query });
  }

  /**
   * Download audio to temp and return a Track ready for playback.
   */
  async downloadAndPlay(item: BilibiliSearchItem): Promise<Track> {
    const filePath = await invoke<string>("download_online_audio", {
      bvid: item.bvid,
      downloadDir: null,
    });

    return this.buildTrack(item, filePath);
  }

  /**
   * Download audio to the user's music library folder and add it
   * to the local track collection so it appears alongside local files.
   */
  async saveToLibrary(
    item: BilibiliSearchItem,
    musicFolder: string,
  ): Promise<Track> {
    // Save under a "Bilibili" subfolder in the user's music directory.
    const saveDir = `${musicFolder}/Bilibili`;

    const filePath = await invoke<string>("download_online_audio", {
      bvid: item.bvid,
      downloadDir: saveDir,
    });

    const track = this.buildTrack(item, filePath);

    // Add to the library so it shows up in Tracks/Albums/Artists views.
    const lib = LibraryManager.getInstance();
    lib.addTrack(track);

    return track;
  }

  /** Always available — uses native Bilibili API, no external tools needed. */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  private buildTrack(item: BilibiliSearchItem, filePath: string): Track {
    return new Track({
      filePath,
      title: item.title,
      artist: item.author,
      album: "Bilibili",
      albumArtist: item.author,
      durationSecs: item.duration_secs,
      genre: "Online",
      hasArtwork: false,
    });
  }
}
