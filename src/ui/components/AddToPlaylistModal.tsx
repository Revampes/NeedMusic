import React, { useEffect, useState, useCallback } from "react";
import type { Track } from "@core/models/Track";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { IconPlus, IconClose, IconPlaylist } from "@ui/components/Icons";

interface SavedPlaylist {
  id: string;
  name: string;
}

interface AddToPlaylistModalProps {
  track: Track;
  onClose: () => void;
  /** Optional callback fired after any playlist mutation so the parent can re-sync the LAN server. */
  onChanged?: () => void;
}

/**
 * Modal for adding a track to playlists.
 * - A text input lets the user create a NEW playlist (created on Add if non-empty).
 * - A checkbox list lets the user select MULTIPLE existing playlists to add the track into.
 */
const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({ track, onClose, onChanged }) => {
  const db = DatabaseManager.getInstance();
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);
  const [newName, setNewName] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = await db.getAllPlaylists();
    setPlaylists(list);
  }, [db]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    setBusy(true);
    try {
      const targets: string[] = playlists
        .filter((p) => checked[p.id])
        .map((p) => p.id);

      // 1. Create a new playlist if the user typed a non-empty title.
      const name = newName.trim();
      if (name) {
        const id = `pl_${Date.now()}`;
        await db.createPlaylist(id, name);
        targets.push(id);
      }

      // 2. Add the track into every selected playlist.
      for (const id of targets) {
        await db.addTrackToPlaylist(id, track.id);
      }

      onChanged?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="add-to-playlist-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="atp-header">
          <span className="atp-title"><IconPlaylist size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Add to playlist</span>
          <button className="atp-close" onClick={onClose} title="Close"><IconClose size={14} /></button>
        </div>

        <div className="atp-track">
          <div className="atp-track-title">{track.title}</div>
          <div className="atp-track-meta">{track.artist} · {track.album}</div>
        </div>

        <div className="atp-section-label">New playlist</div>
        <input
          className="atp-input"
          type="text"
          placeholder="Enter a playlist title to create one…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && handleAdd()}
          autoFocus
        />

        <div className="atp-section-label">Existing playlists</div>
        <div className="atp-list">
          {playlists.length === 0 ? (
            <div className="atp-empty">No playlists yet — create one above.</div>
          ) : (
            playlists.map((p) => (
              <label key={p.id} className="atp-item">
                <input
                  type="checkbox"
                  checked={!!checked[p.id]}
                  onChange={() => toggle(p.id)}
                />
                <span className="atp-item-name"><IconPlaylist size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />{p.name}</span>
              </label>
            ))
          )}
        </div>

        <div className="atp-actions">
          <button className="atp-btn atp-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="atp-btn atp-add" onClick={handleAdd} disabled={busy}>
            <IconPlus size={13} style={{ marginRight: 4, verticalAlign: "middle" }} />
            {busy ? "Adding…" : "Add to playlist"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddToPlaylistModal;
