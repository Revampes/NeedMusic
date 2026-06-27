/**
 * WebPlatformBridge — web/PWA implementation of IPlatformBridge.
 *
 * Uses localStorage for settings, CustomEvent for cross-component
 * communication, and stubs for desktop-only features.
 */

import type { IPlatformBridge, IPlatformWindow } from "./PlatformBridge";

class WebWindow implements IPlatformWindow {
  async show(): Promise<void> { /* web page is always visible */ }
  async setFocus(): Promise<void> { window.focus(); }
  async onFocusChanged(
    handler: (event: { payload: boolean }) => void
  ): Promise<() => void> {
    const onFocus = () => handler({ payload: true });
    const onBlur = () => handler({ payload: false });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }
  async minimize(): Promise<void> { /* not supported in browser */ }
  async maximize(): Promise<void> { /* not supported in browser */ }
  async close(): Promise<void> { /* not supported in browser */ }
}

// ─── Settings via localStorage ───────────────────────

const SETTINGS_PREFIX = "needmusic:setting:";

function _allSettings(): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(SETTINGS_PREFIX)) {
      result[key.slice(SETTINGS_PREFIX.length)] = localStorage.getItem(key) ?? "";
    }
  }
  return result;
}

// ─── Simple in-memory online search cache ─────────────

const _onlineCache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Command stubs ───────────────────────────────────

async function _stubInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  switch (cmd) {
    // ── Settings (via localStorage) ──
    case "get_setting": {
      const key = args?.key as string;
      return (localStorage.getItem(SETTINGS_PREFIX + key) ?? null) as T;
    }
    case "set_setting": {
      const key = args?.key as string;
      const value = args?.value as string;
      localStorage.setItem(SETTINGS_PREFIX + key, value);
      return undefined as T;
    }
    case "delete_setting": {
      const key = args?.key as string;
      localStorage.removeItem(SETTINGS_PREFIX + key);
      return undefined as T;
    }
    case "get_all_settings": {
      return _allSettings() as T;
    }

    // ── Online search cache ──
    case "get_cached_search": {
      const query = args?.query as string;
      const cached = _onlineCache.get(query);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.data as T;
      }
      return null as T;
    }
    case "set_cached_search": {
      const query = args?.query as string;
      const data = args?.data;
      _onlineCache.set(query, { data, ts: Date.now() });
      return undefined as T;
    }
    case "clear_online_cache": {
      _onlineCache.clear();
      return undefined as T;
    }

    // ── Online search (direct fetch to Bilibili API) ──
    case "search_bilibili": {
      const query = args?.query as string;
      const resp = await fetch(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}`
      );
      const json = await resp.json();
      return json as T;
    }

    // ── Desktop-only stubs (no-ops on web) ──
    case "set_window_blur":
    case "set_close_to_tray":
    case "set_autostart":
    case "toggle_dynamic_island":
    case "set_island_always_on_top":
    case "read_audio_file":
    case "extract_artwork":
    case "read_metadata":
    case "scan_directory":
    case "get_scan_status":
    case "set_playback_state":
      return undefined as T;

    case "is_discord_rpc_enabled":
      return false as T;

    default:
      console.warn(`[WebPlatformBridge] Unknown command: ${cmd}`);
      return undefined as T;
  }
}

// ─── Exported singleton ──────────────────────────────

class WebPlatformBridge implements IPlatformBridge {
  private _window = new WebWindow();

  async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return _stubInvoke<T>(cmd, args);
  }

  async emit(event: string, payload: unknown): Promise<void> {
    window.dispatchEvent(new CustomEvent(`needmusic:${event}`, { detail: payload }));
  }

  async listen<T = unknown>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    const listener = (e: Event) => {
      handler((e as CustomEvent).detail as T);
    };
    window.addEventListener(`needmusic:${event}`, listener);
    return () => window.removeEventListener(`needmusic:${event}`, listener);
  }

  getWindow(): IPlatformWindow {
    return this._window;
  }

  async getSetting(key: string): Promise<string | null> {
    return localStorage.getItem(SETTINGS_PREFIX + key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    localStorage.setItem(SETTINGS_PREFIX + key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    localStorage.removeItem(SETTINGS_PREFIX + key);
  }

  async getAllSettings(): Promise<Record<string, string>> {
    return _allSettings();
  }
}

export const webPlatformBridge = new WebPlatformBridge();
