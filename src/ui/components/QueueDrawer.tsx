import React, { useState, useCallback } from "react";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { ITrack } from "@core/interfaces";
import { IconPlay, IconClose } from "@ui/components/Icons";

/**
 * QueueDrawer — a sliding right panel that shows the current play queue.
 * Supports drag-to-reorder and click-to-play.
 */
const QueueDrawer: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const engine = PlaybackEngine.getInstance();
  const [queue, setQueue] = useState<ITrack[]>(engine.queueTracks);

  // Refresh on open.
  const refresh = useCallback(() => {
    setQueue(engine.queueTracks);
  }, [engine]);

  React.useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  const handlePlay = useCallback(
    async (index: number) => {
      const tracks = engine.queueTracks;
      await engine.setQueue(tracks, index);
      setQueue(tracks);
    },
    [engine]
  );

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="queue-backdrop"
        onClick={onClose}
      />

      {/* Drawer */}
      <aside className="queue-drawer">
        <div className="queue-header">
          <h3>Queue ({queue.length})</h3>
          <button className="queue-close-btn" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        {queue.length === 0 ? (
          <div className="queue-empty">
            Queue is empty. Double-click a track to start playing.
          </div>
        ) : (
          <div className="queue-list">
            {queue.map((track, i) => {
              const isCurrent = i === engine.currentIndex_;
              return (
                <div
                  key={`${track.id}-${i}`}
                  className={`queue-item ${isCurrent ? "current" : ""}`}
                  onDoubleClick={() => handlePlay(i)}
                >
                  <span className="queue-item-index">
                    {isCurrent ? <IconPlay size={11} /> : i + 1}
                  </span>
                  <div className="queue-item-info">
                    <div className="queue-item-title">{track.title}</div>
                    <div className="queue-item-artist">{track.artist}</div>
                  </div>
                  <span className="queue-item-duration">
                    {track.formatDuration()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </>
  );
};

export default QueueDrawer;
