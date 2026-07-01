import React, { useState, useEffect, useCallback, useRef } from "react";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { LibraryManager } from "@core/services/LibraryManager";
import { ITrack } from "@core/interfaces";
import { IconPlay, IconClose } from "@ui/components/Icons";
import MarqueeText from "@ui/components/MarqueeText";

/**
 * QueuePanel — always-visible right-side panel showing the play queue.
 * Supports drag-to-reorder, drag-in from track list, and per-track removal.
 */
const QueuePanel: React.FC = () => {
  const engine = PlaybackEngine.getInstance();
  const lib = LibraryManager.getInstance();
  const [queue, setQueue] = useState<ITrack[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

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

  // ── Native drop zone listeners (bypasses React synthetic event quirks) ──
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    let dragCounter = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
      setDragOver(true);
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        setDragOver(false);
        dragCounter = 0;
      }
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      dragCounter = 0;
      const trackId = e.dataTransfer?.getData("text/plain");
      if (!trackId) return;
      const allTracks = lib.getAllTracks();
      const track = allTracks.find((t) => t.id === trackId);
      if (track) {
        engine.enqueue(track);
        refresh();
      }
    };

    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);

    return () => {
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [engine, lib, refresh]);

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
    const dt = (e.nativeEvent || e).dataTransfer;
    // External drag (from track list): allow drop
    if (dragIdx === null) {
      if (dt) dt.dropEffect = "copy";
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

  const currentIdx = engine.currentIndex_;

  return (
    <aside
      ref={panelRef}
      className={`queue-panel ${dragOver ? "queue-panel-dragover" : ""}`}
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
