/**
 * PlatformBridge — abstracts Tauri desktop APIs so the same UI code
 * can run on both desktop (Tauri) and web (browser/PWA).
 *
 * The desktop build imports the real Tauri APIs.
 * The web build imports stubs and web-native alternatives.
 */

export interface IPlatformWindow {
  show(): Promise<void>;
  setFocus(): Promise<void>;
  onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<() => void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
}

export interface IPlatformBridge {
  /** Invoke a Tauri command (desktop) or execute a web stub. */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;

  /** Emit a cross-window event (desktop: Tauri event, web: CustomEvent). */
  emit(event: string, payload: unknown): Promise<void>;

  /** Listen for cross-window events. Returns an unsubscribe function. */
  listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void>;

  /** Get the current window handle. */
  getWindow(): IPlatformWindow;

  /** Get a persisted setting. */
  getSetting(key: string): Promise<string | null>;

  /** Persist a setting. */
  setSetting(key: string, value: string): Promise<void>;

  /** Delete a persisted setting. */
  deleteSetting(key: string): Promise<void>;

  /** Get all settings as a key-value map. */
  getAllSettings(): Promise<Record<string, string>>;
}
