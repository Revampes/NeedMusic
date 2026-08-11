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
  /** Non-fatal error from the Bilibili search (kept tolerant — see search_combined). */
  bilibili_error?: string | null;
  /** Non-fatal error from the YouTube search. */
  youtube_error?: string | null;
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
      title: item.title,
      artist: item.author,
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
    const filePath = await invoke<string>("download_online_audio", {
      source: item.source,
      idOrUrl: item.source === "youtube" ? item.url : item.bvid,
      downloadDir: musicFolder,
      title: item.title,
      artist: item.author,
    });

    const track = this.buildTrack(item, filePath);

    const lib = LibraryManager.getInstance();
    lib.addTrack(track);

    return track;
  }

  /**
   * Save the track INTO the library WITHOUT downloading any audio file.
   *
   * The stored track carries a virtual identifier as its file path
   * (`bilibili://{bvid}` / `youtube://{url}`). When it is played, the
   * NativeAudioPlayer detects the virtual path and resolves the stream
   * through the source's API into the temp cache — the music library
   * folder is never touched.
   */
  async saveToLibraryVirtual(item: OnlineSearchItem): Promise<Track> {
    const virtualPath =
      item.source === "youtube"
        ? Track.ONLINE_YOUTUBE_PREFIX + (item.url || item.id)
        : Track.ONLINE_BILIBILI_PREFIX + (item.bvid || item.id);

    const track = new Track({
      filePath: virtualPath,
      title: item.title,
      artist: item.author,
      album: item.source === "youtube" ? "YouTube" : "Bilibili",
      albumArtist: item.author,
      durationSecs: item.duration_secs,
      genre: "Online",
      hasArtwork: false,
    });

    const lib = LibraryManager.getInstance();
    // addTrack skips duplicates (same virtual id → same track id).
    await lib.addTrack(track);
    return track;
  }

  /**
   * Merge two platform-ranked result lists into one mixed list. Each
   * platform's internal ordering (best match first) is preserved; the merge
   * round-robins between them so neither source dominates the top of the list.
   */
  mergeResults(
    bilibili: OnlineSearchItem[],
    youtube: OnlineSearchItem[],
  ): OnlineSearchItem[] {
    const merged: OnlineSearchItem[] = [];
    const maxLen = Math.max(bilibili.length, youtube.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < bilibili.length) merged.push(bilibili[i]);
      if (i < youtube.length) merged.push(youtube[i]);
    }
    return merged;
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
