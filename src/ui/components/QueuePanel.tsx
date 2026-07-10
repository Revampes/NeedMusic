import React, { useState, useEffect, useCallback } from "react";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { LibraryManager } from "@core/services/LibraryManager";
import { ITrack } from "@core/interfaces";
import { IconPlay, IconClose } from "@ui/components/Icons";
import MarqueeText from "@ui/components/MarqueeText";

interface QueuePanelProps {
  /** Optional track lookup — when provided, used instead of LibraryManager. */
  libraryTracks?: ITrack[];
}

/**
 * QueuePanel — always-visible right-side panel showing the play queue.
 * Supports drag-to-reorder, drag-in from track list, and per-track removal.
 */
const QueuePanel: React.FC<QueuePanelProps> = ({ libraryTracks }) => {
  const engine = PlaybackEngine.getInstance();
  const lib = LibraryManager.getInstance();
  const [queue, setQueue] = useState<ITrack[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

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

  // ── External drop handler ──
  const handleExternalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const trackId = e.dataTransfer.getData("text/plain");
    if (!trackId) return;
    const allTracks = libraryTracks ?? lib.getAllTracks();
    const track = allTracks.find((t) => t.id === trackId);
    if (track) {
      engine.enqueue(track);
      refresh();
    }
  };

  const currentIdx = engine.currentIndex_;

  return (
    <aside
      className={`queue-panel ${dragOver ? "queue-panel-dragover" : ""}`}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
      onDrop={handleExternalDrop}
    >
      <div className="queue-panel-header">
        <span>Queue ({queue.length})</span>
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
              onDragEnd={handleDragEnd}
              onDoubleClick={() => handlePlay(i)}
            >
              <span className="qp-idx">{i === currentIdx ? <IconPlay size={11} /> : i + 1}</span>
              <div className="qp-info">
                <MarqueeText className="qp-title">{t.title}</MarqueeText>
                <div className="qp-artist">{t.artist}</div>
              </div>
              <button className="qp-remove" onClick={(e) => { e.stopPropagation(); handleRemove(i); }} title="Remove from queue"><IconClose size={11} /></button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
};

export default QueuePanel;
