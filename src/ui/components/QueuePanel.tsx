import React, { useState, useEffect, useCallback, useRef } from "react";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { LibraryManager } from "@core/services/LibraryManager";
import { DragBridge } from "@core/services/DragBridge";
import { ITrack } from "@core/interfaces";
import { IconPlay, IconClose } from "@ui/components/Icons";
import MarqueeText from "@ui/components/MarqueeText";

interface QueuePanelProps {
  /** Optional track lookup — when provided, used instead of LibraryManager. */
  libraryTracks?: ITrack[];
  /** Bumped externally when the queue is mutated outside this component. */
  queueVersion?: number;
}

/**
 * QueuePanel — always-visible right-side panel showing the play queue.
 * Supports drag-to-reorder, drag-in from track list, and per-track removal.
 */
const QueuePanel: React.FC<QueuePanelProps> = ({ libraryTracks, queueVersion }) => {
  const engine = PlaybackEngine.getInstance();
  const lib = LibraryManager.getInstance();
  const [queue, setQueue] = useState<ITrack[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragEnterCounter = useRef(0);

  const refresh = useCallback(() => {
    const q = engine.queueTracks;
    console.log("[QueuePanel] refresh — queue length:", q.length);
    setQueue(q);
  }, [engine]);

  useEffect(() => {
    refresh();
    const unsub = engine.subscribe({
      onStateChange: () => {},
      onTrackChange: () => {
        console.log("[QueuePanel] onTrackChange fired, queue length:", engine.queueTracks.length);
        refresh();
      },
      onProgressChange: () => {},
      onVolumeChange: () => {},
    });
    return unsub;
  }, [engine, refresh]);

  // Direct refresh when parent bumps queueVersion (bypasses observer timing issues)
  useEffect(() => {
    if (queueVersion !== undefined && queueVersion > 0) {
      console.log("[QueuePanel] queueVersion bump:", queueVersion);
      refresh();
    }
  }, [queueVersion]);

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
    console.log("[QueuePanel] onDrop fired, dataTransfer.types:", Array.from(e.dataTransfer.types));
    e.preventDefault();
    e.stopPropagation();
    dragEnterCounter.current = 0;
    setDragOver(false);

    // Use DragBridge instead of dataTransfer — WebView2 has unreliable
    // dataTransfer support for internal drag-and-drop.
    const bridgeId = DragBridge.takeDraggedTrackId();
    console.log("[QueuePanel] DragBridge ID:", bridgeId);
    // WebView2: try both "text/plain" and "Text" (capital T) formats
    const dtId = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("Text");
    console.log("[QueuePanel] dataTransfer ID:", dtId);

    const id = bridgeId || dtId;
    if (!id) {
      console.log("[QueuePanel] No track ID found — aborting");
      return;
    }

    const allTracks = libraryTracks ?? lib.getAllTracks();
    const track = allTracks.find((t) => t.id === id);
    console.log("[QueuePanel] Found track:", track?.title ?? "NOT FOUND");
    if (track) {
      engine.enqueue(track);
      refresh();
      console.log("[QueuePanel] Track enqueued:", track.title);
    }
  };

  const currentIdx = engine.currentIndex_;

  return (
    <aside
      className={`queue-panel ${dragOver ? "queue-panel-dragover" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragEnterCounter.current += 1;
        console.log("[QueuePanel] dragEnter, counter:", dragEnterCounter.current);
        if (dragEnterCounter.current === 1) setDragOver(true);
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragEnterCounter.current -= 1;
        console.log("[QueuePanel] dragLeave, counter:", dragEnterCounter.current);
        if (dragEnterCounter.current <= 0) {
          dragEnterCounter.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={handleExternalDrop}
    >
      <div className="queue-panel-header">
        <span>Queue ({queue.length})</span>
        {queue.length > 0 && (
          <button
            className="queue-play-all-btn"
            title="Play queue from start"
            onClick={() => engine.setQueue(engine.queueTracks, 0)}
          >
            <IconPlay size={12} />
          </button>
        )}
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
