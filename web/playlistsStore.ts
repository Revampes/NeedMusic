/**
 * playlistsStore — the localStorage-backed playlist store used by the web app.
 * Extracted so both the UI (WebApp) and the Drive-sync envelope builder can
 * read/write the same data and a single save path can notify sync.
 */

export interface WebPlaylist {
  id: string;
  name: string;
  trackIds: string[];
}

const PLAYLS_KEY = "needmusic:playlists";

export function loadPlaylists(): WebPlaylist[] {
  try { return JSON.parse(localStorage.getItem(PLAYLS_KEY) || "[]"); } catch { return []; }
}

export function savePlaylists(pl: WebPlaylist[]): void {
  localStorage.setItem(PLAYLS_KEY, JSON.stringify(pl));
  // Notify any listeners (Drive sync) that playlists changed.
  window.dispatchEvent(new Event("needmusic:playlists-changed"));
}

/** Merge playlists received from a remote source into the local store. */
export function mergePlaylists(
  remote: { id: string; name: string; trackIds?: string[] }[],
  onChanged: (pl: WebPlaylist[]) => void,
): void {
  const local = loadPlaylists();
  const byId = new Map(local.map((p) => [p.id, p]));
  for (const rp of remote) {
    byId.set(rp.id, { id: rp.id, name: rp.name, trackIds: rp.trackIds ?? [] });
  }
  const merged = [...byId.values()];
  savePlaylists(merged);
  onChanged(merged);
}
