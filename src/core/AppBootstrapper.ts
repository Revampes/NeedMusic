/**
 * Application bootstrap — initializes all core services and wires them together.
 *
 * This is the entry point called from main.tsx. It follows the OOP principle
 * of a dedicated Bootstrapper class that orchestrates initialization.
 */

import { PlaybackEngine } from "./services/PlaybackEngine";
import { DatabaseManager } from "./services/DatabaseManager";
import { LibraryManager } from "./services/LibraryManager";
import { NativeAudioPlayer } from "./services/NativeAudioPlayer";

export class AppBootstrapper {
  private static instance: AppBootstrapper | null = null;

  private initialized = false;

  private constructor() {}

  static getInstance(): AppBootstrapper {
    if (!AppBootstrapper.instance) {
      AppBootstrapper.instance = new AppBootstrapper();
    }
    return AppBootstrapper.instance;
  }

  /**
   * Initialize all core services. Must be called once at application startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log("[NeedMusic] Initializing core services...");

    try {
      // 1. Initialize database.
      console.log("[NeedMusic] Step 1/3: Initializing database...");
      const dbManager = DatabaseManager.getInstance();
      await dbManager.initialize();
      console.log("[NeedMusic] Database initialized.");

      // Ensure Favorites playlist exists.
      const favsId = "__favorites__";
      const playlists = await dbManager.getAllPlaylists();
      if (!playlists.find(p => p.id === favsId)) {
        await dbManager.createPlaylist(favsId, "❤️ Favorites");
      }

      // 2. Load library into memory.
      console.log("[NeedMusic] Step 2/3: Loading library...");
      const libraryManager = LibraryManager.getInstance();
      await libraryManager.initialize();
      console.log("[NeedMusic] Library loaded.");

      // 3. Set up audio output.
      console.log("[NeedMusic] Step 3/3: Configuring audio...");
      const playbackEngine = PlaybackEngine.getInstance();
      playbackEngine.setAudioOutput(new NativeAudioPlayer());
      console.log("[NeedMusic] Audio output configured.");

      this.initialized = true;
      console.log("[NeedMusic] Bootstrap complete.");
    } catch (err) {
      console.error("[NeedMusic] Bootstrap FAILED:", err);
      throw err;
    }
  }
}
