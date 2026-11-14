import { invoke } from "@tauri-apps/api/core";
import { Track } from "@core/models/Track";
import { LibraryManager } from "./LibraryManager";
import { DatabaseManager } from "./DatabaseManager";

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
  cid?: number;           // Cached Bilibili page id, when available
}

export interface TrendingMusicItem {
  bvid: string;
  cid: number;
  title: string;
  owner_name: string;
  pic: string;
  duration: number;
  view: number;
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
  private trendingFetchPromise: Promise<TrendingMusicItem[]> | null = null;

  static getInstance(): OnlineMusicService {
    if (!OnlineMusicService.instance) {
      OnlineMusicService.instance = new OnlineMusicService();
    }
    return OnlineMusicService.instance;
  }

  private static readonly TRENDING_CACHE_KEY = "bilibiliTrendingMusic";
  private static readonly TRENDING_TTL_MS = 8 * 60 * 60 * 1000;
  private static readonly RECOMMENDED_CACHE_KEY = "bilibiliRecommendedMusic";
  private static readonly RECOMMENDED_TTL_MS = 18 * 60 * 60 * 1000;
  private recommendedFetchPromise: Promise<TrendingMusicItem[]> | null = null;

  /** Return cached ranking metadata, fetching it only when expired or forced. */
  async fetchTrendingMusic(forceRefresh = false): Promise<TrendingMusicItem[]> {
    const db = DatabaseManager.getInstance();
    const cached = await db.getSetting(OnlineMusicService.TRENDING_CACHE_KEY);
    if (!forceRefresh && cached) {
      try {
        const parsed = JSON.parse(cached) as { fetchedAt: number; items: TrendingMusicItem[] };
        if (Date.now() - parsed.fetchedAt < OnlineMusicService.TRENDING_TTL_MS) {
          return parsed.items;
        }
      } catch {
        // Corrupt cache is treated as expired.
      }
    }

    if (this.trendingFetchPromise) return this.trendingFetchPromise;
    this.trendingFetchPromise = (async () => {
      const items = await invoke<TrendingMusicItem[]>("fetch_trending_music");
      await db.setSetting(
        OnlineMusicService.TRENDING_CACHE_KEY,
        JSON.stringify({ fetchedAt: Date.now(), items }),
      );
      return items;
    })();
    try {
      return await this.trendingFetchPromise;
    } finally {
      this.trendingFetchPromise = null;
    }
  }

  /** Read the existing trending cache without causing a network request. */
  async getCachedTrendingMusic(): Promise<TrendingMusicItem[]> {
    const cached = await DatabaseManager.getInstance().getSetting(
      OnlineMusicService.TRENDING_CACHE_KEY,
    );
    if (!cached) return [];
    try {
      const parsed = JSON.parse(cached) as {
        fetchedAt: number;
        items: TrendingMusicItem[];
      };
      return Date.now() - parsed.fetchedAt < OnlineMusicService.TRENDING_TTL_MS
        ? parsed.items
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Build personalized Bilibili recommendations from local listening seeds.
   * Related-video metadata is cached; playback URLs are deliberately not.
   */
  async fetchRecommendedMusic(): Promise<TrendingMusicItem[]> {
    const db = DatabaseManager.getInstance();
    const cached = await db.getSetting(OnlineMusicService.RECOMMENDED_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          fetchedAt: number;
          items: TrendingMusicItem[];
        };
        if (Date.now() - parsed.fetchedAt < OnlineMusicService.RECOMMENDED_TTL_MS) {
          return parsed.items;
        }
      } catch {
        // Replace malformed cache below.
      }
    }
    if (this.recommendedFetchPromise) return this.recommendedFetchPromise;

    this.recommendedFetchPromise = (async () => {
      const history = await db.getOnlineListeningHistory();
      const savedBvids = new Set([
        ...(await db.getOnlineLibrarySources()),
        ...LibraryManager.getInstance()
          .getAllTracks()
          .map((track) =>
            track.onlineBvid ||
            (track.filePath.startsWith(Track.ONLINE_BILIBILI_PREFIX)
              ? track.filePath.slice(Track.ONLINE_BILIBILI_PREFIX.length)
              : null),
          )
          .filter((bvid): bvid is string => Boolean(bvid)),
      ]);
      const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentBvids = new Set(
        history
          .filter((entry) => {
            const timestamp = Date.parse(`${entry.lastPlayed.replace(" ", "T")}Z`);
            return Number.isFinite(timestamp) && timestamp >= recentCutoff;
          })
          .map((entry) => entry.bvid),
      );
      const favoriteBvids = LibraryManager.getInstance()
        .getAllTracks()
        .filter((track) => track.isFavorite)
        .map((track) =>
          track.onlineBvid ||
          (track.filePath.startsWith(Track.ONLINE_BILIBILI_PREFIX)
            ? track.filePath.slice(Track.ONLINE_BILIBILI_PREFIX.length)
            : null),
        )
        .filter((bvid): bvid is string => Boolean(bvid));
      const seedBvids = [
        ...history.map((entry) => entry.bvid),
        ...favoriteBvids,
      ].filter((bvid, index, list) => list.indexOf(bvid) === index);

      let items: TrendingMusicItem[];
      if (seedBvids.length < 2) {
        const trending = await this.getCachedTrendingMusic();
        items = this.shuffle(
          trending.filter((item) => !savedBvids.has(item.bvid) && !recentBvids.has(item.bvid)),
        ).slice(0, 20);
      } else {
        items = await invoke<TrendingMusicItem[]>("fetch_related_music", {
          seedBvids: seedBvids.slice(0, 3),
          excludedBvids: [...new Set([...savedBvids, ...recentBvids])],
        });
      }

      await db.setSetting(
        OnlineMusicService.RECOMMENDED_CACHE_KEY,
        JSON.stringify({ fetchedAt: Date.now(), items }),
      );
      return items;
    })();
    try {
      return await this.recommendedFetchPromise;
    } finally {
      this.recommendedFetchPromise = null;
    }
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
      cid: item.cid ?? null,
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
      cid: item.cid ?? null,
      downloadDir: musicFolder,
      title: item.title,
      artist: item.author,
    });

    const track = this.buildTrack(item, filePath);

    const lib = LibraryManager.getInstance();
    await lib.addTrack(track);
    if (item.source === "bilibili") {
      await DatabaseManager.getInstance().recordOnlineLibrarySource(item.bvid);
    }

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
      onlineBvid: item.source === "bilibili" ? item.bvid : null,
    });

    const lib = LibraryManager.getInstance();
    // addTrack skips duplicates (same virtual id → same track id).
    await lib.addTrack(track);
    if (item.source === "bilibili") {
      await DatabaseManager.getInstance().recordOnlineLibrarySource(item.bvid);
    }
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
      onlineBvid: item.source === "bilibili" ? item.bvid : null,
    });
  }

  private shuffle<T>(items: T[]): T[] {
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }
}
