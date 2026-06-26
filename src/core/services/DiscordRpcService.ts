import { invoke } from "@tauri-apps/api/core";

/**
 * DiscordRpcService — manages the Discord Rich Presence integration
 * from the frontend. Calls Tauri commands to enable/disable/update
 * the Discord presence shown on the user's profile.
 *
 * Design Pattern: Singleton
 */
export class DiscordRpcService {
  private static instance: DiscordRpcService | null = null;

  private _enabled = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  static getInstance(): DiscordRpcService {
    if (!DiscordRpcService.instance) {
      DiscordRpcService.instance = new DiscordRpcService();
    }
    return DiscordRpcService.instance;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Enable Discord Rich Presence. Call once when user opts in. */
  async enable(): Promise<void> {
    if (this._enabled) return;
    try {
      await invoke("enable_discord_rpc");
      this._enabled = true;
      this.startHeartbeat();
      console.log("[DiscordRpc] Enabled");
    } catch (err) {
      console.error("[DiscordRpc] Failed to enable:", err);
      throw err;
    }
  }

  /** Disable Discord Rich Presence and clear the status. */
  async disable(): Promise<void> {
    if (!this._enabled) return;
    this.stopHeartbeat();
    try {
      await invoke("disable_discord_rpc");
      this._enabled = false;
      console.log("[DiscordRpc] Disabled");
    } catch (err) {
      console.error("[DiscordRpc] Failed to disable:", err);
    }
  }

  /** Check if currently enabled (from Rust state). */
  async refreshEnabled(): Promise<boolean> {
    try {
      this._enabled = await invoke<boolean>("is_discord_rpc_enabled");
    } catch {
      this._enabled = false;
    }
    return this._enabled;
  }

  /**
   * Update the Discord Rich Presence with current track info.
   * Does nothing if Discord RPC is not enabled.
   * Automatically attempts to reconnect if the connection was lost.
   */
  async updatePresence(params: {
    title: string;
    artist: string;
    album: string;
    isPlaying: boolean;
    positionSecs: number;
    durationSecs: number;
  }): Promise<void> {
    if (!this._enabled) return;

    try {
      await invoke("update_discord_presence", {
        title: params.title || "Unknown Title",
        artist: params.artist || "Unknown Artist",
        album: params.album || "Unknown Album",
        isPlaying: params.isPlaying,
        positionSecs: params.positionSecs,
        durationSecs: params.durationSecs,
      });
    } catch (err) {
      // Connection may have been lost. Try to re-enable automatically.
      console.error("[DiscordRpc] Failed to update presence:", err);
      await this.tryRecover();
    }
  }

  /** Clear the Discord presence (e.g., when playback stops). */
  async clearPresence(): Promise<void> {
    if (!this._enabled) return;

    try {
      await invoke("clear_discord_presence");
    } catch (err) {
      console.error("[DiscordRpc] Failed to clear presence:", err);
    }
  }

  // ─── Heartbeat / Keep-Alive ─────────────────────────

  /**
   * Start sending periodic heartbeats to Discord to keep
   * the named pipe connection alive (Windows closes idle pipes).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this._enabled) return;
      invoke("heartbeat_discord_rpc").catch((err) => {
        console.error("[DiscordRpc] Heartbeat failed:", err);
        this.tryRecover();
      });
    }, 15_000); // every 15 seconds
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Auto-Recovery ──────────────────────────────────

  /**
   * Attempt to recover the Discord RPC connection after a failure.
   * Disables, waits briefly, then re-enables to get a fresh connection.
   */
  private async tryRecover(): Promise<void> {
    if (!this._enabled) return;
    try {
      // Disconnect the broken pipe on the Rust side.
      await invoke("disable_discord_rpc");
    } catch {
      // Ignore — it may already be disconnected.
    }

    // Brief delay before reconnecting.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await invoke("enable_discord_rpc");
      console.log("[DiscordRpc] Auto-recovered connection");
    } catch (err) {
      console.error("[DiscordRpc] Auto-recovery failed:", err);
      this._enabled = false;
      this.stopHeartbeat();
    }
  }
}
