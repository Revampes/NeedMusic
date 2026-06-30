import { invoke } from "@tauri-apps/api/core";
import { Track } from "@core/models/Track";
import { LibraryManager } from "./LibraryManager";

/**
 * Raw search result from the Rust backend (used for both Bilibili & YouTube).
 */
export interface OnlineSearchItem {
  source: string;         // "bilibili" or "youtube"
  id: string;
  bvid: string;
  title: string;
  author: string;
  duration: string;       // "3:45"
  duration_secs: number;
  cover_url: string;
  description: string;
  url: string;            // Full URL (YouTube needs this)
}

export interface OnlineSearchResult {
  results: OnlineSearchItem[];
  total: number;
}

export interface CombinedSearchResult {
  bilibili: OnlineSearchResult;
  youtube: OnlineSearchResult;
}

/**
 * Service for searching and downloading music from Bilibili & YouTube.
 *
 * Flow:
 *   1. searchCombined(query) → CombinedSearchResult (both sources)
 *   2. downloadAndPlay(item) → downloads to temp, returns a Track
 *   3. saveToLibrary(item) → downloads to music folder, adds to library
 */
export class OnlineMusicService {
  private static instance: OnlineMusicService | null = null;

  static getInstance(): OnlineMusicService {
    if (!OnlineMusicService.instance) {
      OnlineMusicService.instance = new OnlineMusicService();
    }
    return OnlineMusicService.instance;
  }

  /** Search Bilibili only. */
  async searchBilibili(query: string): Promise<OnlineSearchResult> {
    return await invoke<OnlineSearchResult>("search_bilibili", { query });
  }

  /** Search YouTube only. */
  async searchYouTube(query: string): Promise<OnlineSearchResult> {
    return await invoke<OnlineSearchResult>("search_youtube", { query });
  }

  /** Search both Bilibili and YouTube simultaneously. */
  async searchCombined(query: string): Promise<CombinedSearchResult> {
    return await invoke<CombinedSearchResult>("search_combined", { query });
  }

  /**
   * Download audio to temp and return a Track ready for playback.
   * Works for both Bilibili and YouTube items.
   */
  async downloadAndPlay(item: OnlineSearchItem): Promise<Track> {
    const filePath = await invoke<string>("download_online_audio", {
      source: item.source,
      idOrUrl: item.source === "youtube" ? item.url : item.bvid,
      downloadDir: null,
    });

    return this.buildTrack(item, filePath);
  }

  /**
   * Download audio to the user's music library folder and add it
   * to the local track collection so it appears alongside local files.
   */
  async saveToLibrary(
    item: OnlineSearchItem,
    musicFolder: string,
  ): Promise<Track> {
    const sourceLabel = item.source === "youtube" ? "YouTube" : "Bilibili";
    const saveDir = `${musicFolder}/${sourceLabel}`;

    const filePath = await invoke<string>("download_online_audio", {
      source: item.source,
      idOrUrl: item.source === "youtube" ? item.url : item.bvid,
      downloadDir: saveDir,
    });

    const track = this.buildTrack(item, filePath);

    const lib = LibraryManager.getInstance();
    lib.addTrack(track);

    return track;
  }

  /** Check if yt-dlp is available on the system. */
  async isYtDlpAvailable(): Promise<boolean> {
    try {
      return await invoke<boolean>("is_ytdlp_available");
    } catch {
      return false;
    }
  }

  private buildTrack(item: OnlineSearchItem, filePath: string): Track {
    const albumName = item.source === "youtube" ? "YouTube" : "Bilibili";
    return new Track({
      filePath,
      title: item.title,
      artist: item.author,
      album: albumName,
      albumArtist: item.author,
      durationSecs: item.duration_secs,
      genre: "Online",
      hasArtwork: false,
    });
  }
}
