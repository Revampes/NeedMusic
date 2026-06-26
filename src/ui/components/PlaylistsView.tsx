import React, { useEffect, useState, useCallback } from "react";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { Track } from "@core/models/Track";
import { IconPlaylist, IconClose, IconPlus, IconPlay } from "@ui/components/Icons";

interface SavedPlaylist {
  id: string;
  name: string;
}

interface PlaylistsViewProps {
  tracks: Track[];
}

/**
 * PlaylistsView — shows saved playlists, allows creating new ones,
 * and viewing/deleting existing playlists.
 */
const PlaylistsView: React.FC<PlaylistsViewProps> = ({ tracks }) => {
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const db = DatabaseManager.getInstance();

  const loadPlaylists = useCallback(async () => {
    const list = await db.getAllPlaylists();
    setPlaylists(list);
  }, [db]);

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const id = `pl_${Date.now()}`;
    await db.createPlaylist(id, name);
    setNewName("");
    setShowCreate(false);
    loadPlaylists();
  }, [newName, db, loadPlaylists]);

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id);
    const pts = await db.getPlaylistTracks(id);
    setPlaylistTracks(pts);
  }, [db]);

  const handleDelete = useCallback(async (id: string) => {
    await db.deletePlaylist(id);
    if (selectedId === id) { setSelectedId(null); setPlaylistTracks([]); }
    loadPlaylists();
  }, [db, selectedId, loadPlaylists]);

  const handleAddTrack = useCallback(async (track: Track) => {
    if (!selectedId) return;
    await db.addTrackToPlaylist(selectedId, track.id);
    const pts = await db.getPlaylistTracks(selectedId);
    setPlaylistTracks(pts);
  }, [db, selectedId]);

  const handlePlayAll = useCallback(() => {
    if (playlistTracks.length === 0) return;
    const engine = PlaybackEngine.getInstance();
    engine.setQueue(playlistTracks, 0);
  }, [playlistTracks]);

  const handlePlayTrack = useCallback((track: Track) => {
    const engine = PlaybackEngine.getInstance();
    const idx = playlistTracks.findIndex((t) => t.id === track.id);
    engine.setQueue(playlistTracks, Math.max(0, idx));
  }, [playlistTracks]);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Playlist Sidebar */}
      <div style={{ width: 200, borderRight: "1px solid var(--glass-border)", overflowY: "auto", padding: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 500 }}>PLAYLISTS</span>
          <button
            onClick={() => setShowCreate(true)}
            style={{ background: "none", border: "none", color: "var(--accent-primary)", cursor: "pointer", padding: "2px 6px", borderRadius: 4, display: "flex", alignItems: "center" }}
            title="Create Playlist"
          ><IconPlus size={16} /></button>
        </div>

        {showCreate && (
          <div style={{ marginBottom: 8, display: "flex", gap: 4 }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Playlist name..."
              style={{
                flex: 1, padding: "4px 8px", background: "rgba(255,255,255,0.06)",
                border: "1px solid var(--glass-border-strong)", borderRadius: 4,
                color: "#eee", fontSize: 12, outline: "none",
              }}
            />
            <button onClick={handleCreate} style={{ background: "var(--accent-primary)", border: "none", color: "#fff", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 12 }}>OK</button>
          </div>
        )}

        {playlists.map((pl) => {
          const isFav = pl.id === "__favorites__";
          return (
          <div
            key={pl.id}
            onClick={() => handleSelect(pl.id)}
            style={{
              padding: "6px 8px", borderRadius: 4, cursor: "pointer",
              fontSize: 13, color: selectedId === pl.id ? "var(--accent-primary)" : "var(--text-body)",
              background: selectedId === pl.id ? "var(--glass-bg-active)" : "transparent",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              marginBottom: 2,
            }}
          >
            <span><IconPlaylist size={14} style={{ marginRight: 4 }} />{pl.name}</span>
            {!isFav && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(pl.id); }}
              style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "2px 4px", borderRadius: 2, display: "flex", alignItems: "center" }}
              title="Delete playlist"
            ><IconClose size={12} /></button>
            )}
          </div>
        )})}

        {playlists.length === 0 && !showCreate && (
          <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: 8, textAlign: "center" }}>
            No playlists. Click <IconPlus size={10} /> to create one.
          </div>
        )}
      </div>

      {/* Playlist Tracks */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {selectedId && (
          <div style={{ display: "flex", alignItems: "center", padding: "8px 16px", borderBottom: "1px solid var(--glass-border)" }}>
            <button
              onClick={handlePlayAll}
              style={{ background: "var(--accent-primary)", border: "none", color: "#fff", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
            ><IconPlay size={12} /> Play All</button>
            <span style={{ marginLeft: 12, fontSize: 13, color: "var(--text-secondary)" }}>
              {playlistTracks.length} tracks
            </span>
          </div>
        )}
        {/* Show all tracks available to add when playlist selected */}
        {selectedId && (
          <div style={{ padding: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 4, padding: "0 8px" }}>
              Playlist Tracks
            </div>
            {playlistTracks.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 16, textAlign: "center" }}>
                Empty playlist. Click <IconPlus size={10} /> on tracks in your Library to add them here.
              </div>
            ) : (
              playlistTracks.map((t) => (
                <div key={t.id} className="track-row" onDoubleClick={() => handlePlayTrack(t)}>
                  <span className="col-title">{t.title}</span>
                  <span className="col-artist">{t.artist}</span>
                  <span className="col-dur">{t.formatDuration()}</span>
                </div>
              ))
            )}
            {/* Quick-add from library */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 4, padding: "0 8px" }}>
                Add from Library
              </div>
              {tracks.slice(0, 20).map((t) => (
                <div key={t.id} className="track-row" style={{ opacity: playlistTracks.some((pt) => pt.id === t.id) ? 0.4 : 1 }}>
                  <span className="col-title">{t.title}</span>
                  <span className="col-artist">{t.artist}</span>
                  <span
                    className="col-add"
                    title="Add to playlist"
                    onClick={(e) => { e.stopPropagation(); handleAddTrack(t); }}
                  ><IconPlus size={14} /></span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!selectedId && (
          <div style={{ color: "var(--text-muted)", fontSize: 14, padding: 48, textAlign: "center" }}>
            Select or create a playlist to view its tracks.
          </div>
        )}
      </div>
    </div>
  );
};

export default PlaylistsView;
