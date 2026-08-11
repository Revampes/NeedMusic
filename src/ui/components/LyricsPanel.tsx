import React, { useState, useEffect, useRef, useCallback } from "react";
import { Track } from "@core/models/Track";
import { LyricsService, LyricLine, findCurrentLine } from "@core/services/LyricsService";
import { IconClose, IconMusic } from "@ui/components/Icons";

interface LyricsPanelProps {
  /** The currently loaded track (may be null / non-lyric tracks). */
  track: Track | null;
  currentTimeSecs: number;
  onClose: () => void;
}

/**
 * LyricsPanel — replaces the right-side Queue/Favorites panel while the user
 * is viewing lyrics. Only Bilibili online tracks carry lyrics; the panel
 * shows a friendly empty state otherwise. The active line is highlighted and
 * auto-scrolled into view as playback progresses.
 */
const LyricsPanel: React.FC<LyricsPanelProps> = ({ track, currentTimeSecs, onClose }) => {
  const [lines, setLines] = useState<LyricLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Fetch lyrics whenever the track changes.
  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setError(null);

    if (!track || track.onlineSource !== "bilibili") {
      setLoading(false);
      return;
    }

    const bvid = track.filePath.slice(Track.ONLINE_BILIBILI_PREFIX.length);
    setLoading(true);
    LyricsService.getLyrics(track.id, bvid)
      .then((l) => { if (!cancelled) setLines(l); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [track?.id]);

  // Auto-scroll the active line to the vertical center.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [lines, Math.floor(currentTimeSecs * 4)]);

  const activeIdx = lines && lines.length > 0 ? findCurrentLine(lines, currentTimeSecs) : -1;

  const renderBody = useCallback(() => {
    if (!track) {
      return <div className="lyrics-empty">No track playing</div>;
    }
    if (loading) {
      return <div className="lyrics-empty"><span className="online-spinner" style={{ margin: "0 auto 8px" }} />Loading lyrics…</div>;
    }
    if (error) {
      return <div className="lyrics-empty">No lyrics for this track</div>;
    }
    if (!lines || lines.length === 0) {
      return <div className="lyrics-empty">No lyrics for this track</div>;
    }
    return (
      <div ref={listRef} className="lyrics-list">
        {lines.map((l, i) => (
          <div
            key={`${l.time}-${i}`}
            ref={i === activeIdx ? activeRef : undefined}
            className={`lyric-line ${i === activeIdx ? "active" : ""} ${i < activeIdx ? "passed" : ""}`}
          >
            {l.text}
          </div>
        ))}
      </div>
    );
  }, [track, loading, error, lines, activeIdx]);

  return (
    <aside className="queue-panel">
      <div className="queue-panel-header">
        <span>
          <IconMusic size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
          Lyrics{track ? ` — ${track.title}` : ""}
        </span>
        <button
          className="queue-play-all-btn"
          title="Close lyrics"
          onClick={onClose}
        >
          <IconClose size={12} />
        </button>
      </div>
      {renderBody()}
    </aside>
  );
};

export default LyricsPanel;
