import React, { useState, useEffect, useCallback, useRef } from "react";
import { PlaybackEngine, RepeatMode } from "@core/services/PlaybackEngine";
import { LibraryManager } from "@core/services/LibraryManager";
import { DragBridge } from "@core/services/DragBridge";
import { ITrack } from "@core/interfaces";
import { IconPlay, IconClose, IconHeartFill, IconRepeat, IconRepeatOff } from "@ui/components/Icons";

interface QueuePanelProps {
  /** Optional track lookup — when provided, used instead of LibraryManager. */
  libraryTracks?: ITrack[];
  /** Bumped externally when the queue is mutated outside this component. */
  queueVersion?: number;
  /** Called when a track is dropped onto the Favorites list (force-adds the favorite). */
  onAddFavorite?: (track: ITrack) => void;
}

/**
 * QueuePanel — always-visible right-side panel.
 *
 * Layout: Queue occupies the top half, Favorites the bottom half.
 *  - Queue:  drag-to-reorder, drag-in from track list, per-track removal.
 *  - Favorites: one-click play, drag a track here to add it as a favorite.
 */
const QueuePanel: React.FC<QueuePanelProps> = ({ libraryTracks, queueVersion, onAddFavorite }) => {
  const engine = PlaybackEngine.getInstance();
  const lib = LibraryManager.getInstance();
  const [queue, setQueue] = useState<ITrack[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [favDragOver, setFavDragOver] = useState(false);
  const dragEnterCounter = useRef(0);
  const favDragEnterCounter = useRef(0);

  const refresh = useCallback(() => setQueue(engine.queueTracks), [engine]);

  useEffect(() => {
    refresh();
    const unsub = engine.subscribe({
      onStateChange: () => {},
      onTrackChange: () => refresh(),
      onProgressChange: () => {},
      onVolumeChange: () => {},
    });
    return unsub;
  }, [engine, refresh]);

  // Direct refresh when parent bumps queueVersion (bypasses observer timing issues)
  useEffect(() => {
    if (queueVersion !== undefined && queueVersion > 0) {
      refresh();
    }
  }, [queueVersion]);

  // ── Reset dragOver when ANY HTML5 drag ends (dragEnd fires on source, not target) ──
  // WebView2 cancels drags immediately, so dragLeave may never fire on the queue panel.
  useEffect(() => {
    const reset = () => {
      dragEnterCounter.current = 0;
      favDragEnterCounter.current = 0;
      setDragOver(false);
      setFavDragOver(false);
    };
    document.addEventListener("dragend", reset);
    return () => document.removeEventListener("dragend", reset);
  }, []);

  const handleRemove = (idx: number) => {
    engine.removeFromQueue(idx);
    refresh();
  };

  const handlePlay = (idx: number) => {
    engine.setQueue(engine.queueTracks, idx);
    refresh();
  };

  // ── Internal drag reorder ──
  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOverReorder = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null) {
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (dragIdx === idx) return;
    const newQ = [...queue];
    const [item] = newQ.splice(dragIdx, 1);
    newQ.splice(idx, 0, item);
    engine.clearQueue();
    engine.enqueueAll(newQ);
    setQueue(newQ);
    setDragIdx(idx);
  };
  const handleDragEnd = () => setDragIdx(null);

  // ── External drop handler (queue) ──
  // Handles both HTML5 DnD (web builds) and mouse-event-based drag (Tauri/WebView2).
  const handleExternalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragEnterCounter.current = 0;
    setDragOver(false);

    // Try mouse-event DragBridge first (Tauri/WebView2 primary path),
    // then HTML5 DragBridge fallback, then dataTransfer as last resort.
    const id =
      DragBridge.endMouseDrag() ||
      DragBridge.takeDraggedTrackId() ||
      e.dataTransfer.getData("text/plain") ||
      e.dataTransfer.getData("Text");
    if (!id) return;

    const allTracks = libraryTracks ?? lib.getAllTracks();
    const track = allTracks.find((t) => t.id === id);
    if (track) {
      engine.enqueue(track);
      refresh();
    }
  };

  // ── External drop handler (favorites) ──
  const handleFavoriteDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    favDragEnterCounter.current = 0;
    setFavDragOver(false);

    const id =
      DragBridge.endMouseDrag() ||
      DragBridge.takeDraggedTrackId() ||
      e.dataTransfer.getData("text/plain") ||
      e.dataTransfer.getData("Text");
    if (!id) return;

    const allTracks = libraryTracks ?? lib.getAllTracks();
    const track = allTracks.find((t) => t.id === id);
    if (track && !track.isFavorite && onAddFavorite) {
      // Only add — never toggle an already-favorited track off via drop.
      onAddFavorite(track);
    }
  };

  // ── Mouse-up drop (catches releases that don't trigger HTML5 drop) ──
  const handlePanelMouseUp = (target: "queue" | "favorites") => {
    if (!DragBridge.isDragging) return;
    const trackId = DragBridge.endMouseDrag();
    if (!trackId) return;

    const allTracks = libraryTracks ?? lib.getAllTracks();
    const track = allTracks.find((t) => t.id === trackId);
    if (!track) return;

    if (target === "queue") {
      engine.enqueue(track);
      refresh();
    } else if (target === "favorites" && !track.isFavorite && onAddFavorite) {
      // Only add — never toggle an already-favorited track off via drop.
      onAddFavorite(track);
    }
  };

  // ── Favorites (one-click play) ──
  const favorites = (libraryTracks ?? lib.getAllTracks()).filter((t) => t.isFavorite);
  const handlePlayFavorite = (track: ITrack) => {
    engine.play(track);
  };

  const currentIdx = engine.currentIndex_;
  // Local mirror of the repeat mode so the loop buttons re-render on tap
  // (Playlist loops the whole queue/favorites list; Off = no loop).
  const [, setRepeatTick] = useState(0);
  const looping = engine.repeatMode === RepeatMode.Playlist;
  const toggleLoop = () => {
    engine.repeatMode = looping ? RepeatMode.Off : RepeatMode.Playlist;
    setRepeatTick((t) => t + 1);
  };

  return (
    <aside
      className={`queue-panel ${dragOver ? "queue-panel-dragover" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragEnterCounter.current += 1;
        if (dragEnterCounter.current === 1) setDragOver(true);
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragEnterCounter.current -= 1;
        if (dragEnterCounter.current <= 0) {
          dragEnterCounter.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={handleExternalDrop}
      onMouseUp={() => handlePanelMouseUp("queue")}
    >
      {/* ── Queue (top half) ── */}
      <div className="queue-panel-half">
        <div className="queue-panel-header">
          <span>Queue ({queue.length})</span>
          <div className="queue-header-actions">
            {queue.length > 0 && (
              <>
                <button
                  className={`queue-loop-btn ${looping ? "active" : ""}`}
                  title={looping ? "Looping the queue — tap to turn off" : "Loop the queue"}
                  onClick={toggleLoop}
                >
                  {looping ? <IconRepeat size={12} /> : <IconRepeatOff size={12} />}
                </button>
                <button
                  className="queue-play-all-btn"
                  title="Play queue from start"
                  onClick={() => engine.setQueue(engine.queueTracks, 0)}
                >
                  <IconPlay size={12} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="queue-panel-list">
          {queue.length === 0 ? (
            <div className="queue-panel-empty">Queue is empty.<br/>Drag tracks here or click + to add.</div>
          ) : (
            queue.map((t, i) => (
              <div
                key={`${t.id}-${i}`}
                className={`queue-panel-item ${i === currentIdx ? "current" : ""}`}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOverReorder(e, i)}
                onDrop={(e) => {
                  // When an external track is dropped directly on a queue item,
                  // prevent the browser default (navigate) and call the drop handler.
                  e.preventDefault();
                  e.stopPropagation();
                  handleExternalDrop(e);
                }}
                onDragEnd={handleDragEnd}
                onDoubleClick={() => handlePlay(i)}
              >
                <span className="qp-idx">{i === currentIdx ? <IconPlay size={11} /> : i + 1}</span>
                <div className="qp-info">
                  <span className="multiline-text qp-title">{t.title}</span>
                  <div className="qp-artist">{t.artist}</div>
                </div>
                <button className="qp-remove" onClick={(e) => { e.stopPropagation(); handleRemove(i); }} title="Remove from queue"><IconClose size={11} /></button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Favorites (bottom half) ── */}
      <div
        className={`queue-panel-half ${favDragOver ? "queue-panel-dragover-fav" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          favDragEnterCounter.current += 1;
          if (favDragEnterCounter.current === 1) setFavDragOver(true);
        }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => {
          e.preventDefault();
          favDragEnterCounter.current -= 1;
          if (favDragEnterCounter.current <= 0) {
            favDragEnterCounter.current = 0;
            setFavDragOver(false);
          }
        }}
        onDrop={handleFavoriteDrop}
        onMouseUp={() => handlePanelMouseUp("favorites")}
      >
        <div className="queue-panel-header">
          <span>Favorites ({favorites.length})</span>
          <div className="queue-header-actions">
            {favorites.length > 0 && (
              <>
                <button
                  className={`queue-loop-btn ${looping ? "active" : ""}`}
                  title={looping ? "Looping favorites — tap to turn off" : "Loop favorites"}
                  onClick={toggleLoop}
                >
                  {looping ? <IconRepeat size={12} /> : <IconRepeatOff size={12} />}
                </button>
                <button
                  className="queue-play-all-btn"
                  title="Play all favorites"
                  onClick={() => engine.setQueue(favorites, 0)}
                >
                  <IconPlay size={12} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="queue-fav-list">
          {favorites.length === 0 ? (
            <div className="queue-fav-empty">
              No favorites yet.<br/>Drag a track here to heart it.
            </div>
          ) : (
            favorites.map((t) => (
              <div
                key={t.id}
                className="queue-panel-fav-item"
                title="Click to play"
                onClick={() => handlePlayFavorite(t)}
              >
                <span className="qpf-heart"><IconHeartFill size={11} /></span>
                <div className="qpf-info">
                  <div className="qpf-title">{t.title}</div>
                  <div className="qpf-artist">{t.artist}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
};

export default QueuePanel;
